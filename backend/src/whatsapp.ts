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

/**
 * Pinned WhatsApp Web version. whatsapp-web.js defaults to an old bundled
 * version and otherwise fetches live web.whatsapp.com on every launch, which
 * is non-reproducible and breaks whenever Meta ships a DOM change mid-week.
 * This must match a file in ./.wwebjs_cache/ (strict mode below throws if it
 * is missing instead of silently falling back to live).
 *
 * Bump procedure: connect once with strict:false (or read the version the
 * client persists to .wwebjs_cache after a good launch), copy the new
 * <version>.html into backend/.wwebjs_cache/, update this constant, rebuild.
 */
const PINNED_WEB_VERSION = "2.3000.1046948731";

/** Init retries for transient Puppeteer crashes (see isTransientInitError). */
const INIT_MAX_RETRIES = 2;
const INIT_RETRY_BACKOFF_MS = [2000, 5000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  /**
   * ids with a connect() currently in its initialize phase (before the
   * client is fully up). A second connect() for the same id while present
   * here gets a fast "Already connecting" error instead of spawning a
   * second Chromium on the same session folder.
   */
  private pending = new Set<string>();
  /**
   * Monotonic generation per account, bumped on every connect/disconnect.
   * Async continuations (initialize().catch, wwebjs event handlers, QR
   * deadline timers) capture the generation they started with and ignore
   * themselves if a newer generation exists — so a stale failure from a
   * superseded browser can never kill the replacement client.
   */
  private generation = new Map<string, number>();
  /** In-flight client.destroy() promises, so a new launch waits for teardown. */
  private destroyPromises = new Map<string, Promise<void>>();

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

    // A rebuild kills the container but keeps the sessions volume, so any
    // Chromium Singleton lock left behind points at a dead host and would
    // block every future launch. No browser is alive at boot, so all of them
    // are stale by definition. This MUST run before the auto-connect loop
    // below — otherwise the first launch hits the lock and dies.
    this.clearAllStaleProfileLocks();

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

  isConnecting(id: string): boolean {
    return this.pending.has(id);
  }

  private nextGen(id: string): number {
    const gen = (this.generation.get(id) ?? 0) + 1;
    this.generation.set(id, gen);
    return gen;
  }

  private currentGen(id: string): number {
    return this.generation.get(id) ?? 0;
  }

  private async waitForDestroy(id: string): Promise<void> {
    const p = this.destroyPromises.get(id);
    if (p) {
      try {
        await p;
      } catch {
        // destroy errors are logged at the source; the barrier itself never throws.
      }
    }
  }

  /**
   * Transient browser crashes worth retrying: the page navigated or the
   * target died while whatsapp-web.js was injecting/evaluating. Anything
   * else (bad proxy, missing executable, auth failure) fails fast.
   */
  private isTransientInitError(err: unknown): boolean {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return /Execution context was destroyed|Target closed|Session closed|Protocol error|Navigation failed|net::ERR_|Timed out/i.test(
      msg
    );
  }

  private async initWithRetry(client: Client, id: string, gen: number): Promise<void> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= INIT_MAX_RETRIES; attempt++) {
      if (gen !== this.currentGen(id)) {
        throw new Error("Superseded");
      }
      try {
        await client.initialize();
        return;
      } catch (err) {
        lastErr = err;
        if (gen !== this.currentGen(id)) {
          throw err;
        }
        const transient = this.isTransientInitError(err);
        if (attempt >= INIT_MAX_RETRIES || !transient) {
          throw err;
        }
        const delay = INIT_RETRY_BACKOFF_MS[attempt] ?? 5000;
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(
          `[WhatsApp] Transient init failure for ${id} (attempt ${attempt + 1}/${INIT_MAX_RETRIES + 1}), retrying in ${delay}ms: ${reason}`
        );
        await sleep(delay);
      }
    }
    throw lastErr;
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
    if (this.pending.has(id)) {
      throw new Error("Already connecting");
    }
    // A previous destroy (cancel/refresh/disconnect) may still be closing
    // its browser. Launching now would put two Chromiums on one profile.
    await this.waitForDestroy(id);
    if (this.clients.has(id)) {
      return this.clients.get(id)!;
    }
    if (this.pending.has(id)) {
      throw new Error("Already connecting");
    }

    const account = await prisma.account.findUnique({ where: { id } });
    if (!account) {
      throw new Error("Account not found");
    }

    console.log(`[WhatsApp] Connecting client for ${id}...`);
    this.pending.add(id);
    const gen = this.nextGen(id);
    // The sessions volume survives container rebuilds but the browsers don't:
    // a Singleton lock left by the previous container would make Chromium
    // refuse to start. A live client for this id returns above, and any
    // in-flight destroy was awaited above, so anything still on disk here
    // is orphaned.
    this.clearStaleProfileLocks(id);
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
        this.pending.delete(id);
        await this.fail(id, message, "DISCONNECTED", gen);
        throw new Error(message);
      }
      puppeteerArgs.push(`--proxy-server=${proxyServerArg(proxy)}`);
      if (proxy.username && proxy.password) {
        proxyAuthentication = { username: proxy.username, password: proxy.password };
      }
    }

    // Identity for the WhatsApp session is the account's own id, not its phone
    // number — the phone number isn't known until the QR code is scanned.
    // webVersion is pinned with a strict local cache (see PINNED_WEB_VERSION)
    // so every launch uses the same tested WA Web bundle instead of whatever
    // Meta happens to serve that minute.
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: id,
        dataPath: SESSIONS_ROOT
      }),
      webVersion: PINNED_WEB_VERSION,
      webVersionCache: {
        type: "local",
        path: "./.wwebjs_cache/",
        strict: true
      },
      ...(proxyAuthentication ? { proxyAuthentication } : {}),
      puppeteer: {
        headless: true,
        executablePath: chromePath,
        args: puppeteerArgs
      }
    });

    this.clients.set(id, client);

    client.on("qr", async (qrString) => {
      if (gen !== this.currentGen(id)) return;
      console.log(`[WhatsApp] QR code generated for ${id}`);
      try {
        const dataUrl = await qrcode.toDataURL(qrString);
        if (gen !== this.currentGen(id)) return;
        const expiresAt = this.deadlineFor(id);
        this.qrs.set(id, { dataUrl, expiresAt });
        whatsappEvents.emit("qr", { id, qr: dataUrl, expiresAt });
      } catch (err) {
        console.error("[WhatsApp] Error generating QR Data URL:", err);
      }
    });

    client.on("authenticated", () => {
      if (gen !== this.currentGen(id)) return;
      // Scanned — the browser is no longer idling on a QR screen.
      console.log(`[WhatsApp] Authenticated ${id}`);
      this.clearDeadline(id);
      this.qrs.delete(id);
    });

    client.on("ready", async () => {
      if (gen !== this.currentGen(id)) return;
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
      if (gen !== this.currentGen(id)) return;
      console.error(`[WhatsApp] Auth failure for ${id}:`, msg);
      await this.fail(id, `Ошибка авторизации: ${msg}`, "DISCONNECTED", gen);
    });

    client.on("disconnected", async (reason) => {
      if (gen !== this.currentGen(id)) return;
      console.log(`[WhatsApp] Client disconnected for ${id}:`, reason);
      // WhatsApp reports an unlinked or blocked device by tearing the session down.
      const banned = typeof reason === "string" && /ban|conflict/i.test(reason);
      await this.fail(
        id,
        `Соединение разорвано: ${reason}`,
        banned ? "BANNED" : "DISCONNECTED",
        gen
      );
    });

    this.armDeadline(id, gen);

    try {
      await this.initWithRetry(client, id, gen);
    } catch (err) {
      if (gen !== this.currentGen(id)) {
        // Superseded by a newer connect/disconnect — the replacement owns the row now.
        this.pending.delete(id);
        throw err;
      }
      if (err instanceof Error && err.message === "Superseded") {
        this.pending.delete(id);
        throw err;
      }
      console.error(`[WhatsApp] Initialization error for ${id}:`, err);
      const message = err instanceof Error ? err.message : "Не удалось запустить браузер";
      await this.fail(id, message || "Не удалось запустить браузер", "DISCONNECTED", gen);
      this.pending.delete(id);
      // init errors are recorded via fail(); don't rethrow so background
      // callers (routes, boot auto-connect) keep their fire-and-forget shape.
      return client;
    }

    this.pending.delete(id);
    return client;
  }

  /** Stops the client but keeps the stored session, so the next login skips the QR. */
  async disconnect(id: string, emitStatus = true): Promise<void> {
    console.log(`[WhatsApp] Disconnecting client for ${id}...`);
    // Invalidate any in-flight initialize/event callbacks for this id first,
    // so their late failures can't clobber the DISCONNECTED state we write below.
    this.nextGen(id);
    this.pending.delete(id);
    this.clearDeadline(id);
    this.qrs.delete(id);
    await this.destroyClient(id);
    await prisma.account.updateMany({
      where: { id },
      data: { status: "DISCONNECTED" }
    });
    if (emitStatus) {
      this.emitStatus(id, "DISCONNECTED");
    }
  }

  /** Unlinks the device on the phone's side and wipes the local session. */
  async logout(id: string): Promise<void> {
    console.log(`[WhatsApp] Logging out ${id}...`);
    this.nextGen(id);
    this.pending.delete(id);
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
    this.nextGen(id);
    this.pending.delete(id);
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
    // Silent: the row is about to disappear, so broadcasting DISCONNECTED for
    // it first only makes the dashboard flicker.
    await this.disconnect(id, false);
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
    // at its QR right now. Pending covers the gap between the connect guard
    // and clients.set, so a row can't be deleted under a launching browser.
    const abandoned = stale.filter((acc) => !this.clients.has(acc.id) && !this.pending.has(acc.id));
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
  private async fail(id: string, message: string, status = "DISCONNECTED", gen?: number) {
    if (gen !== undefined && gen !== this.currentGen(id)) {
      return;
    }
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

  private armDeadline(id: string, gen: number) {
    this.clearDeadline(id);
    const timer = setTimeout(() => {
      this.deadlines.delete(id);
      if (gen !== this.currentGen(id)) return;
      console.log(`[WhatsApp] QR window expired for ${id}`);
      whatsappEvents.emit("qr_expired", { id });
      // The browser goes away, but the profile row stays so the dashboard can
      // offer "обновить код". If it really is abandoned, sweepPending collects it.
      this.fail(id, "QR-код устарел — его никто не отсканировал вовремя", "DISCONNECTED", gen).catch((err) =>
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

  /**
   * Removes orphaned Chromium Singleton lockfiles for one profile. They are
   * only meaningful while their browser is alive; after a container rebuild
   * they point at a dead host and block every launch with "profile appears
   * to be in use". NOTE: these are DANGLING SYMLINKS (e.g. SingletonLock ->
   * <dead-hostname>-<pid>), so fs.existsSync() reports false for them — it
   * follows the link. Always rm unconditionally with force:true instead.
   */
  private clearStaleProfileLocks(id: string) {
    const dir = this.sessionDir(id);
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      const file = path.join(dir, name);
      try {
        fs.rmSync(file, { force: true });
      } catch (err) {
        console.error(`[WhatsApp] Failed to remove ${name} for ${id}:`, err);
      }
    }
  }

  /** Same as above, for every stored profile — runs once at boot. */
  private clearAllStaleProfileLocks() {
    let dirents: fs.Dirent[] = [];
    try {
      dirents = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirents) {
      if (entry.isDirectory() && entry.name.startsWith("session-")) {
        this.clearStaleProfileLocks(entry.name.slice("session-".length));
      }
    }
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
    // Serialize teardowns per id and let a racing connect() wait for us via
    // waitForDestroy(). The map entry is removed up front so isRunning()
    // goes false immediately, but the browser close is awaited.
    const prev = this.destroyPromises.get(id);
    if (prev) {
      try {
        await prev;
      } catch {
        // Logged at the source.
      }
    }
    const client = this.clients.get(id);
    this.clients.delete(id);
    if (!client) return;
    const p = (async () => {
      try {
        await client.destroy();
      } catch (e) {
        console.error(`[WhatsApp] Error destroying client ${id}:`, e);
      }
    })();
    this.destroyPromises.set(id, p);
    try {
      await p;
    } finally {
      if (this.destroyPromises.get(id) === p) {
        this.destroyPromises.delete(id);
      }
    }
  }
}

export const wsManager = new WhatsAppManager();
export default wsManager;
