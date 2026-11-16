// Лог отправленных сообщений в Google Таблицу через Apps Script webhook.
// Работает только если заданы SHEETS_WEBHOOK_URL и SHEETS_WEBHOOK_TOKEN.
// Ошибки логирования никогда не ломают рассылку: батчим строки и отправляем в фоне.

const URL_ = process.env.SHEETS_WEBHOOK_URL || "";
const TOKEN = process.env.SHEETS_WEBHOOK_TOKEN || "";
const FLUSH_MS = 5000;
const MAX_BATCH = 100;
const MAX_QUEUE = 5000;

type Row = (string | number)[];

let queue: Row[] = [];
let timer: NodeJS.Timeout | null = null;
let flushing = false;

export const sheetsLogEnabled = Boolean(URL_ && TOKEN);

function fmtDate(d: Date): string {
  const tz = process.env.TZ || "Asia/Almaty";
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

async function flush() {
  if (flushing || queue.length === 0) return;
  flushing = true;
  const batch = queue.splice(0, MAX_BATCH);
  try {
    const res = await fetch(URL_, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token: TOKEN, rows: batch }),
      redirect: "follow",
      signal: AbortSignal.timeout(20000)
    });
    const text = await res.text();
    if (!res.ok || text.trim() !== "ok") {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
    }
  } catch (err: any) {
    console.warn(`[SheetsLog] flush failed, will retry: ${err?.message ?? err}`);
    queue = batch.concat(queue).slice(0, MAX_QUEUE);
  } finally {
    flushing = false;
  }
  if (queue.length > 0) schedule();
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, FLUSH_MS);
}

export function logToSheet(entry: {
  campaign: string;
  phone: string;
  name?: string | null;
  sender: string;
  status: "SENT" | "FAILED";
  error?: string | null;
  text?: string | null;
}) {
  if (!sheetsLogEnabled) return;
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push([
    fmtDate(new Date()),
    entry.campaign,
    entry.phone,
    entry.name ?? "",
    entry.sender,
    entry.status === "SENT" ? "Отправлено" : "Ошибка",
    entry.error ?? "",
    (entry.text ?? "").slice(0, 2000)
  ]);
  schedule();
}
