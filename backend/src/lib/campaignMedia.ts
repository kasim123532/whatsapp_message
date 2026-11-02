import fs from "fs";
import path from "path";

/** WhatsApp truncates captions beyond this. */
export const MAX_CAPTION_LENGTH = 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Lives on the backend-data volume (/app/data) so photos survive rebuilds. */
export const MEDIA_DIR = process.env.MEDIA_DIR || path.join(process.cwd(), "data", "campaign-media");

export function ensureMediaDir() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

/** Detects the real format from magic bytes — the client-sent MIME is not trusted. */
export function sniffImage(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { mime: "image/png", ext: "png" };
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP")
    return { mime: "image/webp", ext: "webp" };
  return null;
}

/** Resolves a stored file name inside MEDIA_DIR; null if it would escape it. */
export function mediaPath(fileName: string): string | null {
  const full = path.resolve(MEDIA_DIR, fileName);
  return path.dirname(full) === path.resolve(MEDIA_DIR) ? full : null;
}

export function mediaExists(fileName: string | null | undefined): boolean {
  if (!fileName) return false;
  const full = mediaPath(fileName);
  return !!full && fs.existsSync(full);
}

export function removeMedia(fileName: string | null | undefined) {
  if (!fileName) return;
  const full = mediaPath(fileName);
  if (full) fs.rmSync(full, { force: true });
}
