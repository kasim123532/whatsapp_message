import { Router } from "express";
import { prisma } from "../db.js";
import { wsManager } from "../whatsapp.js";
import { parseProxy } from "../lib/proxy.js";

const router = Router();

/** Attaches the live (in-memory) QR state to a stored account row. */
function withLiveState<T extends { id: string }>(account: T) {
  return {
    ...account,
    qr: wsManager.getQr(account.id) || null,
    qrExpiresAt: wsManager.getQrExpiresAt(account.id) || null,
    running: wsManager.isRunning(account.id)
  };
}

// GET all accounts
router.get("/", async (req, res) => {
  try {
    const accounts = await prisma.account.findMany({ orderBy: { createdAt: "desc" } });
    res.json(accounts.map(withLiveState));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET single account (minimal, public-safe) — used by the shareable /connect/:id link
router.get("/:id/status", async (req, res) => {
  const { id } = req.params;
  try {
    const account = await prisma.account.findUnique({ where: { id } });
    if (!account) {
      return res.status(404).json({ error: "Ссылка недействительна: аккаунт не найден" });
    }
    res.json({
      id: account.id,
      phone: account.phone,
      name: account.name,
      status: account.status,
      qr: wsManager.getQr(id) || null,
      qrExpiresAt: wsManager.getQrExpiresAt(id) || null,
      running: wsManager.isRunning(id)
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST create account — phone number is optional, it's discovered automatically
// once the QR code is scanned. Pass `draft: true` for a profile that should be
// discarded again if nobody ever scans it (the QR page does this).
router.post("/", async (req, res) => {
  const { phone, name, proxy, draft } = req.body || {};

  try {
    let cleanPhone: string | null = null;
    if (phone && String(phone).trim()) {
      cleanPhone = String(phone).replace(/\D/g, "");
      const existing = await prisma.account.findUnique({
        where: { phone: cleanPhone }
      });
      if (existing) {
        return res.status(400).json({ error: "Account with this phone already exists" });
      }
    }

    const rawProxy = typeof proxy === "string" ? proxy.trim() : "";
    if (rawProxy && !parseProxy(rawProxy)) {
      return res.status(400).json({
        error: "Неверный формат прокси. Ожидается host:port, host:port:user:pass или scheme://user:pass@host:port"
      });
    }

    const account = await prisma.account.create({
      data: {
        phone: cleanPhone,
        name: name || "",
        proxy: rawProxy,
        status: "DISCONNECTED",
        isDraft: Boolean(draft)
      }
    });

    res.status(201).json(withLiveState(account));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH account — rename, reassign proxy, set an individual daily limit
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const { name, proxy, dailyLimit, draft } = req.body || {};

  try {
    const account = await prisma.account.findUnique({ where: { id } });
    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    const data: Record<string, unknown> = {};

    if (name !== undefined) {
      data.name = String(name).trim();
    }

    let proxyChanged = false;
    if (proxy !== undefined) {
      const rawProxy = String(proxy).trim();
      if (rawProxy && !parseProxy(rawProxy)) {
        return res.status(400).json({
          error: "Неверный формат прокси. Ожидается host:port, host:port:user:pass или scheme://user:pass@host:port"
        });
      }
      proxyChanged = rawProxy !== (account.proxy || "");
      data.proxy = rawProxy;
    }

    // Sharing the invite link means the profile has to outlive the operator's
    // own QR dialog, so it stops being a throwaway draft.
    if (draft !== undefined) {
      data.isDraft = Boolean(draft);
    }

    if (dailyLimit !== undefined) {
      const parsed = parseInt(String(dailyLimit), 10);
      if (Number.isNaN(parsed) || parsed < 0) {
        return res.status(400).json({ error: "Лимит должен быть неотрицательным числом" });
      }
      data.dailyLimit = parsed;
    }

    // A running client has the old proxy baked into its browser flags, so the
    // session has to be restarted for a new one to take effect.
    const needsRestart = proxyChanged && wsManager.isRunning(id);
    if (needsRestart) {
      await wsManager.disconnect(id);
    }

    const updated = await prisma.account.update({ where: { id }, data });

    if (needsRestart) {
      wsManager.connect(id).catch((err) => {
        console.error(`Error reconnecting account ${id} after proxy change:`, err);
      });
    }

    res.json({ ...withLiveState(updated), restarted: needsRestart });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE account
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const account = await prisma.account.findUnique({ where: { id } });
    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    await wsManager.deleteAccount(id);
    await prisma.account.delete({ where: { id } });

    res.json({ message: "Account deleted successfully" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST connect account — also used by the public /connect/:id page
router.post("/:id/connect", async (req, res) => {
  const { id } = req.params;
  try {
    const account = await prisma.account.findUnique({ where: { id } });
    if (!account) {
      return res.status(404).json({ error: "Account not found in database" });
    }

    // Trigger connection in background (async)
    wsManager.connect(id).catch(err => {
      console.error(`Error connecting account ${id}:`, err);
    });

    res.json({ message: "Connecting initiated", status: "CONNECTING" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST restart the QR handshake — used by the "код устарел, обновить" button
router.post("/:id/refresh-qr", async (req, res) => {
  const { id } = req.params;
  try {
    const account = await prisma.account.findUnique({ where: { id } });
    if (!account) {
      return res.status(404).json({ error: "Account not found in database" });
    }
    if (account.status === "CONNECTED") {
      return res.status(400).json({ error: "Профиль уже подключен" });
    }

    // Drop the stale browser first, otherwise connect() would just hand back the
    // client that is already sitting on an expired code.
    await wsManager.disconnect(id);
    wsManager.connect(id).catch((err) => {
      console.error(`Error refreshing QR for account ${id}:`, err);
    });

    res.json({ message: "QR refresh initiated", status: "CONNECTING" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST cancel a pending QR login — discards the profile when it was a draft
router.post("/:id/cancel", async (req, res) => {
  const { id } = req.params;
  try {
    const deleted = await wsManager.cancelConnect(id);
    res.json({ message: deleted ? "Draft discarded" : "Connection cancelled", deleted });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST disconnect account — stops the session but keeps it linked
router.post("/:id/disconnect", async (req, res) => {
  const { id } = req.params;
  try {
    await wsManager.disconnect(id);
    res.json({ message: "Disconnected successfully", status: "DISCONNECTED" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST log out — unlinks the device and wipes the local session, so the next
// login needs a fresh QR scan
router.post("/:id/logout", async (req, res) => {
  const { id } = req.params;
  try {
    const account = await prisma.account.findUnique({ where: { id } });
    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }
    await wsManager.logout(id);
    res.json({ message: "Logged out successfully", status: "DISCONNECTED" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST set limit
router.post("/limit", async (req, res) => {
  const { ids, limit } = req.body;
  if (!Array.isArray(ids) || limit === undefined) {
    return res.status(400).json({ error: "Invalid body. Expecting ids: string[] and limit: number" });
  }

  try {
    await prisma.account.updateMany({
      where: { id: { in: ids } },
      data: { dailyLimit: parseInt(limit) || 0 }
    });
    res.json({ message: "Limit updated successfully" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
