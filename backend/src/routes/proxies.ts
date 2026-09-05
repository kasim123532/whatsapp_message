import { Router } from "express";
import { prisma } from "../db.js";
import { parseProxy } from "../lib/proxy.js";

const router = Router();

// GET all proxies
router.get("/", async (req, res) => {
  try {
    const proxies = await prisma.proxy.findMany({ orderBy: { createdAt: "desc" } });
    res.json(proxies);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST bulk-add proxies from a pasted text block, one per line
router.post("/", async (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "Expecting { text: string } — one proxy per line" });
  }

  const lines = [...new Set(
    text.split("\n").map((line) => line.trim()).filter(Boolean)
  )];

  if (lines.length === 0) {
    return res.status(400).json({ error: "No proxies found in text" });
  }

  // Reject unparseable lines here rather than letting them fail later inside a
  // headless browser launch, where the cause is much harder to see.
  const invalid = lines.filter((line) => !parseProxy(line));
  const valid = lines.filter((line) => parseProxy(line));

  if (valid.length === 0) {
    return res.status(400).json({
      error: "Ни одна строка не распознана. Форматы: host:port, host:port:user:pass, scheme://user:pass@host:port",
      invalid
    });
  }

  try {
    const existing = await prisma.proxy.findMany({ where: { value: { in: valid } } });
    const existingValues = new Set(existing.map((p) => p.value));
    const newLines = valid.filter((line) => !existingValues.has(line));

    if (newLines.length > 0) {
      await prisma.proxy.createMany({ data: newLines.map((value) => ({ value })) });
    }

    res.status(201).json({
      added: newLines.length,
      skipped: valid.length - newLines.length,
      invalid
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE a proxy
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.proxy.delete({ where: { id } });
    res.json({ message: "Proxy deleted" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
