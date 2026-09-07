import { Router, type Request, type Response } from "express";
import type { Account } from "@prisma/client";
import { prisma } from "../db.js";
import { wsManager, whatsappEvents } from "../whatsapp.js";
import { parseProxy } from "../lib/proxy.js";

const router = Router();

/** Wraps async handlers so rejections become a 500 instead of a hung request. */
function handle<T>(fn: (req: Request, res: Response) => Promise<T>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      console.error(`[Accounts] ${req.method} ${req.path} failed:`, err);
      if (!res.headersSent) {
        res.status(500).json({ error: err?.message || "Internal error" });
      }
    });
  };
}

const PROXY_ERROR =
  "Неверный формат прокси. Ожидается host:port, host:port:user:pass или scheme://user:pass@host:port";

const MAX_NAME_LENGTH = 100;

/** Attaches the live (in-memory) QR state to a stored account row. */
function withLiveState(account: Account) {
  return {
    ...account,
    qr: wsManager.getQr(account.id) || null,
    qrExpiresAt: wsManager.getQrExpiresAt(account.id) || null,
    running: wsManager.isRunning(account.id),
    // When this profile self-destructs for never having been scanned; null once
    // a phone is linked to it.
    pendingExpiresAt: wsManager.pendingDeadline(account)
  };
}

/** Minimal public-safe payload for the shareable /connect/:id link. */
function statusPayload(account: Account) {
  return {
    id: account.id,
    phone: account.phone,
    name: account.name,
    status: account.status,
    qr: wsManager.getQr(account.id) || null,
    qrExpiresAt: wsManager.getQrExpiresAt(account.id) || null,
    running: wsManager.isRunning(account.id)
  };
}

/** Validates a proxy form value. "" means "no proxy". Returns the trimmed value. */
function cleanProxy(value: unknown): { ok: true; proxy: string } | { ok: false; error: string } {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw && !parseProxy(raw)) {
    return { ok: false, error: PROXY_ERROR };
  }
  return { ok: true, proxy: raw };
}

/** Canonical form for change detection: `example.com:8080` and
 * `http://example.com:8080` are the same proxy and must not trigger a restart. */
function canonicalProxy(raw: string): string {
  const parsed = parseProxy(raw);
  if (!parsed) return raw.trim();
  const auth = parsed.username
    ? `${parsed.username}:${parsed.password ?? ""}@`
    : "";
  return `${parsed.protocol}://${auth}${parsed.host}:${parsed.port}`;
}

/** Parses a daily-limit form value. Null means invalid. */
function parseDailyLimit(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || (parsed as number) < 0) return null;
  return parsed as number;
}

function cleanName(value: unknown): string {
  return String(value ?? "").trim().slice(0, MAX_NAME_LENGTH);
}

// ---------------------------------------------------------------------------
// Collection + static routes (kept above `/:id` so they can't be shadowed)
// ---------------------------------------------------------------------------

// GET all accounts
router.get(
  "/",
  handle(async (_req, res) => {
    const accounts = await prisma.account.findMany({ orderBy: { createdAt: "desc" } });
    res.json(accounts.map(withLiveState));
  })
);

async function setLimits(req: Request, res: Response) {
  const { ids, limit } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string")) {
    return res.status(400).json({ error: "Invalid body. Expecting ids: string[] and limit: number" });
  }
  const parsed = parseDailyLimit(limit);
  if (parsed === null) {
    return res.status(400).json({ error: "Лимит должен быть неотрицательным числом" });
  }

  const uniqueIds = [...new Set(ids)];
  const result = await prisma.account.updateMany({
    where: { id: { in: uniqueIds } },
    data: { dailyLimit: parsed }
  });
  res.json({ message: "Limit updated successfully", updated: result.count });
}

// PATCH is the canonical verb; POST stays as an alias for the dashboard build
// that already calls it.
router.patch("/limit", handle(setLimits));
router.post("/limit", handle(setLimits));

// DELETE bulk — one round trip instead of N sequential DELETE /:id calls.
router.delete(
  "/",
  handle(async (req, res) => {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string")) {
      return res.status(400).json({ error: "Invalid body. Expecting ids: string[]" });
    }

    const uniqueIds = [...new Set(ids)];
    const failed: { id: string; error: string }[] = [];
    for (const id of uniqueIds) {
      try {
        const account = await prisma.account.findUnique({ where: { id } });
        if (!account) {
          failed.push({ id, error: "Account not found" });
          continue;
        }
        await wsManager.deleteAccount(id);
        await prisma.account.delete({ where: { id } });
        whatsappEvents.emit("removed", { id });
      } catch (err: any) {
        failed.push({ id, error: err?.message || "Delete failed" });
      }
    }

    const deleted = uniqueIds.length - failed.length;
    if (failed.length > 0 && deleted === 0) {
      return res.status(404).json({ message: "No accounts deleted", deleted, failed });
    }
    res.json({
      message:
        failed.length === 0
          ? deleted === 1
            ? "Account deleted successfully"
            : `${deleted} accounts deleted successfully`
          : `${deleted} deleted, ${failed.length} failed`,
      deleted,
      ...(failed.length > 0 ? { failed } : {})
    });
  })
);

// POST create account — phone number is optional, it's discovered automatically
// once the QR code is scanned. A new profile is a draft by default: until a
// phone is actually linked there is nothing in it worth keeping, so the janitor
// collects it if nobody scans. Sharing its /connect link clears the flag.
router.post(
  "/",
  handle(async (req, res) => {
    const { phone, name, proxy, draft } = req.body || {};

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

    const checked = cleanProxy(proxy ?? "");
    if (!checked.ok) {
      return res.status(400).json({ error: checked.error });
    }

    const account = await prisma.account.create({
      data: {
        phone: cleanPhone,
        name: cleanName(name),
        proxy: checked.proxy,
        status: "DISCONNECTED",
        isDraft: draft === undefined ? true : Boolean(draft)
      }
    });

    res.status(201).json(withLiveState(account));
  })
);

// ---------------------------------------------------------------------------
// Single-account routes
// ---------------------------------------------------------------------------

// GET single account (full row + live state)
router.get(
  "/:id",
  handle(async (req, res) => {
    const { id } = req.params;
    const account = await prisma.account.findUnique({ where: { id } });
    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }
    res.json(withLiveState(account));
  })
);

// GET single account (minimal, public-safe) — used by the shareable /connect/:id link
router.get(
  "/:id/status",
  handle(async (req, res) => {
    const { id } = req.params;
    const account = await prisma.account.findUnique({ where: { id } });
    if (!account) {
      return res.status(404).json({ error: "Ссылка недействительна: аккаунт не найден" });
    }
    res.json(statusPayload(account));
  })
);

// PATCH account — rename, reassign proxy, set an individual daily limit
router.patch(
  "/:id",
  handle(async (req, res) => {
    const { id } = req.params;
    const { name, proxy, dailyLimit, draft } = req.body || {};

    const account = await prisma.account.findUnique({ where: { id } });
    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    const data: Record<string, unknown> = {};

    if (name !== undefined) {
      data.name = cleanName(name);
    }

    let proxyChanged = false;
    if (proxy !== undefined) {
      const checked = cleanProxy(proxy);
      if (!checked.ok) {
        return res.status(400).json({ error: checked.error });
      }
      proxyChanged = canonicalProxy(checked.proxy) !== canonicalProxy(account.proxy || "");
      data.proxy = checked.proxy;
    }

    // Sharing the invite link means the profile has to outlive the operator's
    // own QR dialog, so it stops being a throwaway draft.
    if (draft !== undefined) {
      data.isDraft = Boolean(draft);
    }

    if (dailyLimit !== undefined) {
      const parsed = parseDailyLimit(dailyLimit);
      if (parsed === null) {
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
  })
);

// DELETE account
router.delete(
  "/:id",
  handle(async (req, res) => {
    const { id } = req.params;
    const account = await prisma.account.findUnique({ where: { id } });
    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    await wsManager.deleteAccount(id);
    await prisma.account.delete({ where: { id } });
    whatsappEvents.emit("removed", { id });

    res.json({ message: "Account deleted successfully" });
  })
);

// POST connect account — also used by the public /connect/:id page
router.post(
  "/:id/connect",
  handle(async (req, res) => {
    const { id } = req.params;
    const account = await prisma.account.findUnique({ where: { id } });
    if (!account) {
      return res.status(404).json({ error: "Account not found in database" });
    }

    // Trigger connection in background (async)
    wsManager.connect(id).catch((err) => {
      console.error(`Error connecting account ${id}:`, err);
    });

    res.json({ message: "Connecting initiated", status: "CONNECTING" });
  })
);

// POST restart the QR handshake — used by the "код устарел, обновить" button
router.post(
  "/:id/refresh-qr",
  handle(async (req, res) => {
    const { id } = req.params;
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
  })
);

// POST cancel a pending QR login — discards the profile when it was a draft
router.post(
  "/:id/cancel",
  handle(async (req, res) => {
    const { id } = req.params;
    const pendingExpiresAt = await wsManager.cancelConnect(id);
    res.json({ message: "Connection cancelled", pendingExpiresAt });
  })
);

// POST disconnect account — stops the session but keeps it linked
router.post(
  "/:id/disconnect",
  handle(async (req, res) => {
    const { id } = req.params;
    await wsManager.disconnect(id);
    res.json({ message: "Disconnected successfully", status: "DISCONNECTED" });
  })
);

// POST log out — unlinks the device and wipes the local session, so the next
// login needs a fresh QR scan
router.post(
  "/:id/logout",
  handle(async (req, res) => {
    const { id } = req.params;
    const account = await prisma.account.findUnique({ where: { id } });
    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }
    await wsManager.logout(id);
    res.json({ message: "Logged out successfully", status: "DISCONNECTED" });
  })
);

export default router;
