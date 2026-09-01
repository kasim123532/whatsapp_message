import { Client, LocalAuth } from "whatsapp-web.js";
import { prisma } from "./db.js";
import qrcode from "qrcode";
import { EventEmitter } from "events";
import path from "path";
import fs from "fs";

export const whatsappEvents = new EventEmitter();

class WhatsAppManager {
  private clients: Map<string, Client> = new Map();
  private qrs: Map<string, string> = new Map();

  async init() {
    // On startup, we can auto-start clients that were previously marked as CONNECTED.
    const activeAccounts = await prisma.account.findMany({
      where: {
        status: { in: ["CONNECTED", "CONNECTING"] }
      }
    });

    console.log(`[WhatsApp] Auto-connecting ${activeAccounts.length} accounts...`);
    for (const acc of activeAccounts) {
      this.connect(acc.id).catch((err) => {
        console.error(`[WhatsApp] Failed to auto-connect ${acc.id}:`, err);
      });
    }
  }

  getClient(id: string): Client | undefined {
    return this.clients.get(id);
  }

  getQr(id: string): string | undefined {
    return this.qrs.get(id);
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
      data: { status: "CONNECTING" }
    });
    whatsappEvents.emit("status", { id, status: "CONNECTING" });

    const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

    // Identity for the WhatsApp session is the account's own id, not its phone
    // number — the phone number isn't known until the QR code is scanned.
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: id,
        dataPath: path.resolve("./sessions")
      }),
      puppeteer: {
        headless: true,
        executablePath: chromePath,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--single-process",
          "--disable-gpu"
        ]
      }
    });

    this.clients.set(id, client);

    client.on("qr", async (qrString) => {
      console.log(`[WhatsApp] QR code generated for ${id}`);
      try {
        const qrDataUrl = await qrcode.toDataURL(qrString);
        this.qrs.set(id, qrDataUrl);
        whatsappEvents.emit("qr", { id, qr: qrDataUrl });
      } catch (err) {
        console.error("[WhatsApp] Error generating QR Data URL:", err);
      }
    });

    client.on("ready", async () => {
      console.log(`[WhatsApp] Client is ready for ${id}`);
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
            ...(realPhone ? { phone: realPhone } : {})
          }
        });
      } catch (err) {
        // Most likely the discovered phone number already belongs to another account.
        console.error(`[WhatsApp] Could not save phone number for ${id}:`, err);
        await prisma.account.updateMany({
          where: { id },
          data: { status: "CONNECTED", name: connectedName }
        });
      }

      whatsappEvents.emit("status", { id, status: "CONNECTED", phone: realPhone });
      whatsappEvents.emit("ready", { id });
    });

    client.on("auth_failure", async (msg) => {
      console.error(`[WhatsApp] Auth failure for ${id}:`, msg);
      this.qrs.delete(id);
      await this.destroyClient(id);
      await prisma.account.updateMany({
        where: { id },
        data: { status: "DISCONNECTED" }
      });
      whatsappEvents.emit("status", { id, status: "DISCONNECTED" });
    });

    client.on("disconnected", async (reason) => {
      console.log(`[WhatsApp] Client disconnected for ${id}:`, reason);
      this.qrs.delete(id);
      await this.destroyClient(id);
      await prisma.account.updateMany({
        where: { id },
        data: { status: "DISCONNECTED" }
      });
      whatsappEvents.emit("status", { id, status: "DISCONNECTED" });
    });

    client.initialize().catch(async (err) => {
      console.error(`[WhatsApp] Initialization error for ${id}:`, err);
      this.qrs.delete(id);
      await this.destroyClient(id);
      await prisma.account.updateMany({
        where: { id },
        data: { status: "DISCONNECTED" }
      });
      whatsappEvents.emit("status", { id, status: "DISCONNECTED" });
    });

    return client;
  }

  async disconnect(id: string): Promise<void> {
    console.log(`[WhatsApp] Disconnecting client for ${id}...`);
    this.qrs.delete(id);
    await this.destroyClient(id);
    await prisma.account.updateMany({
      where: { id },
      data: { status: "DISCONNECTED" }
    });
    whatsappEvents.emit("status", { id, status: "DISCONNECTED" });
  }

  async deleteAccount(id: string): Promise<void> {
    console.log(`[WhatsApp] Deleting account and sessions for ${id}...`);
    await this.disconnect(id);

    // Remove LocalAuth session dir
    const sessionDir = path.resolve("./sessions", `session-${id}`);
    if (fs.existsSync(sessionDir)) {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        console.log(`[WhatsApp] Removed session folder for ${id}`);
      } catch (err) {
        console.error(`[WhatsApp] Failed to delete session folder for ${id}:`, err);
      }
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
