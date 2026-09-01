import { Router } from "express";
import { prisma } from "../db.js";
import { wsManager } from "../whatsapp.js";

const router = Router();

// GET all accounts
router.get("/", async (req, res) => {
  try {
    const accounts = await prisma.account.findMany();
    // Add current QR code to response if client is generating it
    const accountsWithQr = accounts.map((acc) => ({
      ...acc,
      qr: wsManager.getQr(acc.id) || null
    }));
    res.json(accountsWithQr);
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
      qr: wsManager.getQr(id) || null
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST create account — phone number is optional, it's discovered automatically
// once the QR code is scanned.
router.post("/", async (req, res) => {
  const { phone, name, proxy } = req.body || {};

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

    const account = await prisma.account.create({
      data: {
        phone: cleanPhone,
        name: name || "",
        proxy: proxy || "",
        status: "DISCONNECTED"
      }
    });

    res.status(201).json(account);
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

// POST disconnect account
router.post("/:id/disconnect", async (req, res) => {
  const { id } = req.params;
  try {
    await wsManager.disconnect(id);
    res.json({ message: "Disconnected successfully", status: "DISCONNECTED" });
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
