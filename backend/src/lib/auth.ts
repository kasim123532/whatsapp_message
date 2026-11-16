import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";

/** Minimum gap between two login attempts, for the whole server (not per IP —
 * behind nginx/Cloudflare every visitor shares the proxy's address). */
const LOGIN_INTERVAL_MS = 3000;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Read lazily: dotenv runs in server.ts after the imports are evaluated.
const getPassword = () => process.env.APP_PASSWORD || "";

export function warnIfOpen() {
  if (!getPassword()) {
    console.warn("[Auth] APP_PASSWORD is not set — the dashboard is OPEN to everyone.");
  }
}

function sign(payload: string): string {
  const secret = crypto.createHash("sha256").update(`wa-session:${getPassword()}`).digest();
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function issueToken(): string {
  const exp = String(Date.now() + TOKEN_TTL_MS);
  return `${exp}.${sign(exp)}`;
}

export function isValidToken(token: unknown): boolean {
  if (!getPassword()) return true;
  if (typeof token !== "string") return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < Date.now()) return false;
  return safeEqual(sig, sign(exp));
}

function bearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  // <img> tags cannot send headers: campaign photos accept the token in the query.
  if (req.method === "GET" && /^\/campaigns\/[^/]+\/image$/.test(req.path) && typeof req.query.token === "string") {
    return req.query.token;
  }
  return undefined;
}

/**
 * Endpoints that the shareable /connect/:id page needs. It is opened by
 * someone who has no password, so exactly these three stay public; the
 * unguessable profile id in the link is what protects them.
 */
function isPublic(req: Request): boolean {
  if (req.method === "GET" && /^\/accounts\/[^/]+\/status$/.test(req.path)) return true;
  if (req.method === "POST" && /^\/accounts\/[^/]+\/(connect|refresh-qr)$/.test(req.path)) return true;
  return false;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!getPassword() || isPublic(req) || isValidToken(bearer(req))) {
    return next();
  }
  res.status(401).json({ error: "Требуется вход" });
}

export const authRouter = Router();

let lastAttemptAt = 0;

authRouter.post("/login", (req, res) => {
  const now = Date.now();
  const wait = lastAttemptAt + LOGIN_INTERVAL_MS - now;
  if (wait > 0) {
    res.setHeader("Retry-After", String(Math.ceil(wait / 1000)));
    return res.status(429).json({
      error: `Слишком часто. Повторите через ${Math.ceil(wait / 1000)} сек.`,
      retryAfterMs: wait
    });
  }
  lastAttemptAt = now;

  const given = typeof req.body?.password === "string" ? req.body.password : "";
  if (!getPassword() || !safeEqual(given, getPassword())) {
    return res.status(401).json({ error: "Неверный пароль" });
  }
  res.json({ token: issueToken() });
});

authRouter.get("/check", (req, res) => {
  res.json({ ok: isValidToken(bearer(req)), required: Boolean(getPassword()) });
});
