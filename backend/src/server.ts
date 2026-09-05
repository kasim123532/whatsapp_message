import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { wsManager, whatsappEvents } from "./whatsapp.js";
import { campaignScheduler } from "./services/scheduler.js";
import accountsRouter from "./routes/accounts.js";
import contactsRouter from "./routes/contacts.js";
import templatesRouter from "./routes/templates.js";
import campaignsRouter from "./routes/campaigns.js";
import proxiesRouter from "./routes/proxies.js";

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// API Routes
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
const wss = new WebSocketServer({ server });
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
  startServices();
});
