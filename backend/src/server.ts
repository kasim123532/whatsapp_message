import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { wsManager, whatsappEvents } from "./whatsapp.js";
import { campaignScheduler } from "./services/scheduler.js";
import { logTimeZoneBanner } from "./lib/time.js";
import { setCampaignBroadcaster } from "./lib/campaignEvents.js";
import accountsRouter from "./routes/accounts.js";
import contactsRouter from "./routes/contacts.js";
import templatesRouter from "./routes/templates.js";
import campaignsRouter from "./routes/campaigns.js";
import proxiesRouter from "./routes/proxies.js";
import { authRouter, requireAuth, isValidToken, warnIfOpen } from "./lib/auth.js";

dotenv.config();

warnIfOpen();

/**
 * One banned/unlinked account must never kill the other five.
 * whatsapp-web.js throws async `detached Frame / Target closed` errors from
 * inside its own inject() loop (Client.js:503) AFTER emitting `disconnected`.
 * Nothing in our per-client try/catch can catch those — without these global
 * guards the whole Node process exits and Docker restarts every session.
 * Allowlisted transient browser errors are logged and swallowed; anything
 * else still exits so a truly corrupted process doesn't limp on.
 */
function isBenignBrowserCrash(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err);
  return /detached Frame|Execution context was destroyed|Target closed|Session closed|Protocol error|Navigation failed|net::ERR_|Timed out|Connection closed/i.test(
    msg
  );
}

process.on("uncaughtException", (err) => {
  if (isBenignBrowserCrash(err)) {
    console.error("[Server] Swallowed benign browser crash (process kept alive):", err);
    return;
  }
  console.error("[Server] Fatal uncaughtException, exiting:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  if (isBenignBrowserCrash(reason)) {
    console.error("[Server] Swallowed benign unhandledRejection (process kept alive):", reason);
    return;
  }
  console.error("[Server] Fatal unhandledRejection, exiting:", reason);
  process.exit(1);
});

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// API Routes
app.use("/api/auth", authRouter);
app.use("/api", requireAuth);
app.use("/api/accounts", accountsRouter);
app.use("/api/contacts", contactsRouter);
app.use("/api/templates", templatesRouter);
app.use("/api/campaigns", campaignsRouter);
app.use("/api/proxies", proxiesRouter);

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "OK", time: new Date() });
});

const server = http.createServer(app);

// WebSocket Server
const wss = new WebSocketServer({
  server,
  // Browsers can't set headers on a WebSocket, so the token rides in the query.
  verifyClient: (info, done) => {
    const token = new URL(info.req.url || "/", "http://localhost").searchParams.get("token");
    if (isValidToken(token)) return done(true);
    done(false, 401, "Unauthorized");
  }
});
const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`[WS] Client connected. Total: ${clients.size}`);

  // Send initial statuses or QRs immediately
  ws.send(JSON.stringify({ type: "connection", message: "Connected to WhatsApp WebSocket" }));

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected. Total: ${clients.size}`);
  });
});

// Broadcast helper
const broadcast = (data: any) => {
  const message = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
};
setCampaignBroadcaster(broadcast);

// Connect WhatsApp Event Emitter to WebSockets. The payloads are forwarded as
// they come out of the manager — every one of them is keyed by account `id`,
// which is what the dashboard matches on.
whatsappEvents.on("qr", (payload) => {
  broadcast({ type: "qr", ...payload });
});

whatsappEvents.on("qr_expired", (payload) => {
  broadcast({ type: "qr_expired", ...payload });
});

whatsappEvents.on("status", (payload) => {
  broadcast({ type: "status", ...payload });
});

whatsappEvents.on("removed", (payload) => {
  broadcast({ type: "removed", ...payload });
});

// Start the WhatsApp manager & Scheduler
const startServices = async () => {
  try {
    // 1. Initialize WhatsApp Web Manager (auto-connect accounts)
    await wsManager.init();

    // 2. Start Campaign Scheduler
    campaignScheduler.start();
  } catch (err) {
    console.error("Failed to start background services:", err);
  }
};

server.listen(port, () => {
  console.log(`[Server] API running on http://localhost:${port}`);
  logTimeZoneBanner();
  startServices();
});
