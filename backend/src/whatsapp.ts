import { Client, LocalAuth } from "whatsapp-web.js";
import { prisma } from "./db.js";
import qrcode from "qrcode";
import { EventEmitter } from "events";
import path from "path";
import fs from "fs";
import { parseProxy, proxyServerArg } from "./lib/proxy.js";

export const whatsappEvents = new EventEmitter();

/**
 * How long a profile may sit on the QR screen without anyone scanning it before
 * we tear the headless browser down. WhatsApp itself rotates the code roughly
 * every 20s; this is the outer bound on the whole attempt.
 */
const QR_WINDOW_MS = Number(process.env.QR_WINDOW_MS) || 3 * 60 * 1000;

/**
 * Grace period after the QR window closes. The profile row survives this long
 * with its browser already gone so the dashboard can offer "обновить код" to an
 * operator who was slow; after that the janitor deletes it. A never-linked
 * profile therefore lives QR_WINDOW_MS + PENDING_GRACE_MS from its last attempt.
 */
const PENDING_GRACE_MS = Number(process.env.PENDING_GRACE_MS) || 2 * 60 * 1000;

/** How often the janitor looks for never-linked profiles to collect. */
const SWEEP_INTERVAL_MS = 30 * 1000;

/** A profile row the janitor is allowed to delete. */
type PendingLike = {
  isDraft: boolean;
  phone: string | null;
  status: string;
  lastAttemptAt: Date | null;
  createdAt: Date;
};

const SESSIONS_ROOT = path.resolve("./sessions");

interface QrState {
  dataUrl: string;
  expiresAt: number;
}

class WhatsAppManager {
  private clients: Map<string, Client> = new Map();
  private qrs: Map<string, QrState> = new Map();
  private deadlines: Map<string, NodeJS.Timeout> = new Map();
  private janitor: NodeJS.Timeout | null = null;

  async init() {
    // A CONNECTING row means the process died mid-handshake — there is no live
    // browser behind it any more, so don't pretend there is.
    await prisma.account.updateMany({
      where: { status: "CONNECTING" },
      data: { status: "DISCONNECTED" }
    });

    // Profiles that never linked a phone are disposable no matter which page
    // created them. Older rows predate that rule and were created immortal, so
    // hand them to the janitor rather than leaving them stuck on "ожидание QR"
    // forever.
    const adopted = await prisma.account.updateMany({
      where: { isDraft: false, phone: null, status: { not: "CONNECTED" } },
      data: { isDraft: true }
    });
    if (adopted.count > 0) {
      console.log(`[WhatsApp] ${adopted.count} never-linked profiles marked disposable.`);
    }

    // Only accounts that actually finished a login get resumed, and only when
    // their session folder survived. Everything else waits for a manual login.
    const activeAccounts = await prisma.account.findMany({
      where: { status: "CONNECTED" }
    });

    const resumable = activeAccounts.filter((acc) => this.hasSession(acc.id));
    const orphaned = activeAccounts.filter((acc) => !this.hasSession(acc.id));

    if (orphaned.length > 0) {
      await prisma.account.updateMany({
        where: { id: { in: orphaned.map((a) => a.id) } },
        data: { status: "DISCONNECTED" }
      });
      console.log(`[WhatsApp] ${orphaned.length} accounts lost their session folder, marked disconnected.`);
    }

    console.log(`[WhatsApp] Auto-connecting ${resumable.length} accounts...`);
    for (const acc of resumable) {
      this.connect(acc.id).catch((err) => {
        console.error(`[WhatsApp] Failed to auto-connect ${acc.id}:`, err);
      });
    }

    await this.sweepPending();
    this.janitor = setInterval(() => {
      this.sweepPending().catch((err) => console.error("[WhatsApp] Pending sweep failed:", err));
    }, SWEEP_INTERVAL_MS);
  }

  getClient(id: string): Client | undefined {
    return this.clients.get(id);
  }

  getQr(id: string): string | undefined {
    return this.qrs.get(id)?.dataUrl;
  }

  getQrExpiresAt(id: string): number | undefined {
    return this.qrs.get(id)?.expiresAt;
  }

  isRunning(id: string): boolean {
    return this.clients.has(id);
  }

  /**
   * Moment a never-linked profile gets deleted, or null for a profile that is
   * here to stay. The clock runs from the last connect attempt, so refreshing
   * an expired code buys the operator a fresh full window.
   */
  pendingDeadline(account: PendingLike): number | null {
    if (!account.isDraft || account.phone || account.status === "CONNECTED") {
      return null;
    }
    const since = account.lastAttemptAt ?? account.createdAt;
    return since.getTime() + QR_WINDOW_MS + PENDING_GRACE_MS;
  }

  async connect(id: string): Promise<Client> {
    if (this.clients.has(id)) {
      console.log(`[WhatsApp] Client already exists for ${id}`);
      return this.clients.get(id)!;
    }

    const account = await prisma.account.findUnique({ where: { id } });
    if (!account) {
      throw new Error("Account not found");
    }

    console.log(`[WhatsApp] Connecting client for ${id}...`);
    await prisma.account.updateMany({
      where: { id },
      data: { status: "CONNECTING", lastError: null, lastAttemptAt: new Date() }
    });
    this.emitStatus(id, "CONNECTING");

    const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

    // `--single-process` and `--no-zygote` are deliberately absent: they make
    // Chromium crash under long-lived Puppeteer sessions, which is exactly what
    // a WhatsApp client is. Each account gets a normal multi-process browser.
    const puppeteerArgs = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--disable-gpu"
    ];

    let proxyAuthentication: { username: string; password: string } | undefined;
    if (account.proxy) {
      const proxy = parseProxy(account.proxy);
      if (!proxy) {
        const message = `Не удалось разобрать прокси: ${account.proxy}`;
        console.error(`[WhatsApp] ${message}`);
        await this.fail(id, message);
        throw new Error(message);
      }
      puppeteerArgs.push(`--proxy-server=${proxyServerArg(proxy)}`);
      if (proxy.username && proxy.password) {
        proxyAuthentication = { username: proxy.username, password: proxy.password };
      }
    }

    // Identity for the WhatsApp session is the account's own id, not its phone
    // number — the phone number isn't known until the QR code is scanned.
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: id,
        dataPath: SESSIONS_ROOT
      }),
      ...(proxyAuthentication ? { proxyAuthentication } : {}),
      puppeteer: {
        headless: true,
        executablePath: chromePath,
        args: puppeteerArgs
      }
    });

    this.clients.set(id, client);

    client.on("qr", async (qrString) => {
      console.log(`[WhatsApp] QR code generated for ${id}`);
      try {
        const dataUrl = await qrcode.toDataURL(qrString);
        const expiresAt = this.deadlineFor(id);
        this.qrs.set(id, { dataUrl, expiresAt });
        whatsappEvents.emit("qr", { id, qr: dataUrl, expiresAt });
      } catch (err) {
        console.error("[WhatsApp] Error generating QR Data URL:", err);
      }
    });

    client.on("authenticated", () => {
      // Scanned — the browser is no longer idling on a QR screen.
      console.log(`[WhatsApp] Authenticated ${id}`);
      this.clearDeadline(id);
      this.qrs.delete(id);
    });

    client.on("ready", async () => {
      console.log(`[WhatsApp] Client is ready for ${id}`);
      this.clearDeadline(id);
      this.qrs.delete(id);

      const whatsappInfo = client.info;
      const connectedName = whatsappInfo?.pushname || "WhatsApp Account";
      const realPhone = whatsappInfo?.wid?.user || null;

      try {
        await prisma.account.update({
          where: { id },
          data: {
            status: "CONNECTED",
            name: connectedName,
            isDraft: false,
            lastError: null,
            ...(realPhone ? { phone: realPhone } : {})
          }
        });
      } catch (err) {
        // Most likely the discovered phone number already belongs to another account.
        console.error(`[WhatsApp] Could not save phone number for ${id}:`, err);
        await prisma.account.updateMany({
          where: { id },
          data: {
            status: "CONNECTED",
            name: connectedName,
            isDraft: false,
            lastError: "Этот номер уже привязан к другому профилю"
          }
        });
      }

      this.emitStatus(id, "CONNECTED", realPhone);
      whatsappEvents.emit("ready", { id });
    });

    client.on("auth_failure", async (msg) => {
      console.error(`[WhatsApp] Auth failure for ${id}:`, msg);
      await this.fail(id, `Ошибка авторизации: ${msg}`);
    });

    client.on("disconnected", async (reason) => {
      console.log(`[WhatsApp] Client disconnected for ${id}:`, reason);
      // WhatsApp reports an unlinked or blocked device by tearing the session down.
      const banned = typeof reason === "string" && /ban|conflict/i.test(reason);
      await this.fail(
        id,
        `Соединение разорвано: ${reason}`,
        banned ? "BANNED" : "DISCONNECTED"
      );
    });

    this.armDeadline(id);

    client.initialize().catch(async (err) => {
      console.error(`[WhatsApp] Initialization error for ${id}:`, err);
      await this.fail(id, err?.message || "Не удалось запустить браузер");
    });

    return client;
  }

  /** Stops the client but keeps the stored session, so the next login skips the QR. */
  async disconnect(id: string): Promise<void> {
    console.log(`[WhatsApp] Disconnecting client for ${id}...`);
    this.clearDeadline(id);
    this.qrs.delete(id);
    await this.destroyClient(id);
    await prisma.account.updateMany({
      where: { id },
      data: { status: "DISCONNECTED" }
    });
    this.emitStatus(id, "DISCONNECTED");
  }

  /** Unlinks the device on the phone's side and wipes the local session. */
  async logout(id: string): Promise<void> {
    console.log(`[WhatsApp] Logging out ${id}...`);
    this.clearDeadline(id);
    this.qrs.delete(id);

    const client = this.clients.get(id);
    if (client) {
      try {
        await client.logout();
      } catch (err) {
        // The phone may already have removed the device; the local wipe below
        // is what actually matters.
        console.error(`[WhatsApp] logout() failed for ${id}:`, err);
      }
    }

    await this.destroyClient(id);
    this.removeSession(id);

    await prisma.account.updateMany({
      where: { id },
      data: { status: "DISCONNECTED", phone: null, lastError: null }
    });
    this.emitStatus(id, "DISCONNECTED");
  }

  /**
   * Abandons an in-flight QR login: the headless browser goes away immediately
   * so it stops burning memory, but the profile row stays. A never-linked row
   * keeps counting down to its own deadline, which lets the operator reopen the
   * code from the accounts table instead of re-creating the profile. Returns the
   * moment the row will be collected, or null if it is here to stay.
   */
  async cancelConnect(id: string): Promise<number | null> {
    this.clearDeadline(id);
    this.qrs.delete(id);
    await this.destroyClient(id);

    const account = await prisma.account.findUnique({ where: { id } });
    if (!account) return null;

    await prisma.account.updateMany({
      where: { id },
      data: { status: "DISCONNECTED" }
    });
    this.emitStatus(id, "DISCONNECTED");
    return this.pendingDeadline({ ...account, status: "DISCONNECTED" });
  }

  async deleteAccount(id: string): Promise<void> {
    console.log(`[WhatsApp] Deleting account and sessions for ${id}...`);
    await this.disconnect(id);
    this.removeSession(id);
  }

  /** Drops profiles nobody ever scanned. */
  async sweepPending(): Promise<number> {
    const cutoff = new Date(Date.now() - (QR_WINDOW_MS + PENDING_GRACE_MS));
    const stale = await prisma.account.findMany({
      where: {
        isDraft: true,
        phone: null,
        status: { not: "CONNECTED" },
        // Age from the last attempt; rows that never got one fall back to when
        // they were created.
        OR: [
          { lastAttemptAt: { lt: cutoff } },
          { lastAttemptAt: null, createdAt: { lt: cutoff } }
        ]
      }
    });

    // Never sweep a profile whose browser is still up — somebody may be looking
    // at its QR right now.
    const abandoned = stale.filter((acc) => !this.clients.has(acc.id));
    if (abandoned.length === 0) return 0;

    for (const acc of abandoned) {
      this.removeSession(acc.id);
      this.qrs.delete(acc.id);
      whatsappEvents.emit("removed", { id: acc.id });
    }

    await prisma.account.deleteMany({
      where: { id: { in: abandoned.map((a) => a.id) } }
    });
    console.log(`[WhatsApp] Swept ${abandoned.length} abandoned profiles.`);
    return abandoned.length;
  }

  private emitStatus(id: string, status: string, phone: string | null = null) {
    whatsappEvents.emit("status", { id, status, phone });
  }

  /** Tears the client down and records why, without throwing at the caller. */
  private async fail(id: string, message: string, status = "DISCONNECTED") {
    this.clearDeadline(id);
    this.qrs.delete(id);
    await this.destroyClient(id);
    await prisma.account.updateMany({
      where: { id },
      data: { status, lastError: message }
    });
    whatsappEvents.emit("status", { id, status, phone: null, error: message });
  }

  private deadlineFor(id: string): number {
    const existing = this.qrs.get(id)?.expiresAt;
    return existing ?? Date.now() + QR_WINDOW_MS;
  }

  private armDeadline(id: string) {
    this.clearDeadline(id);
    const timer = setTimeout(() => {
      this.deadlines.delete(id);
      console.log(`[WhatsApp] QR window expired for ${id}`);
      whatsappEvents.emit("qr_expired", { id });
      // The browser goes away, but the profile row stays so the dashboard can
      // offer "обновить код". If it really is abandoned, sweepPending collects it.
      this.fail(id, "QR-код устарел — его никто не отсканировал вовремя").catch((err) =>
        console.error(`[WhatsApp] Failed to clean up expired QR for ${id}:`, err)
      );
    }, QR_WINDOW_MS);
    this.deadlines.set(id, timer);
  }

  private clearDeadline(id: string) {
    const timer = this.deadlines.get(id);
    if (timer) {
      clearTimeout(timer);
      this.deadlines.delete(id);
    }
  }

  private sessionDir(id: string) {
    return path.join(SESSIONS_ROOT, `session-${id}`);
  }

  private hasSession(id: string) {
    return fs.existsSync(this.sessionDir(id));
  }

  private removeSession(id: string) {
    const dir = this.sessionDir(id);
    if (!fs.existsSync(dir)) return;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`[WhatsApp] Removed session folder for ${id}`);
    } catch (err) {
      console.error(`[WhatsApp] Failed to delete session folder for ${id}:`, err);
    }
  }

  private async destroyClient(id: string) {
    const client = this.clients.get(id);
    if (client) {
      this.clients.delete(id);
      try {
        await client.destroy();
      } catch (e) {
        console.error(`[WhatsApp] Error destroying client ${id}:`, e);
      }
    }
  }
}

export const wsManager = new WhatsAppManager();
export default wsManager;
