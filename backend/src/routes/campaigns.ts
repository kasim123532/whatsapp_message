import { Router } from "express";
import ExcelJS from "exceljs";
import { prisma } from "../db.js";
import { notifyCampaign } from "../lib/campaignEvents.js";

const router = Router();

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

function validateIntervals(minInterval: unknown, maxInterval: unknown): { min: number; max: number } | { error: string } {
  const min = parseInt(String(minInterval), 10);
  const max = parseInt(String(maxInterval), 10);
  if (Number.isNaN(min) || Number.isNaN(max) || min <= 0 || max <= 0 || min > max) {
    return { error: "Min interval must be a positive number no greater than max interval" };
  }
  return { min, max };
}

function validateTimeWindow(sendFrom: unknown, sendTo: unknown): { error?: string; sendFrom: string; sendTo: string } {
  const from = typeof sendFrom === "string" && sendFrom ? sendFrom : "08:00";
  const to = typeof sendTo === "string" && sendTo ? sendTo : "20:00";
  if (!HHMM_RE.test(from) || !HHMM_RE.test(to)) {
    return { sendFrom: from, sendTo: to, error: "sendFrom/sendTo must be HH:MM (00:00-23:59)" };
  }
  return { sendFrom: from, sendTo: to };
}

/**
 * Сендеры привязываются к Account.id. Старый формат (phones[]) принимается
 * для совместимости и на лету резолвится в id.
 */
async function resolveSenders(input: { accountIds?: unknown; phones?: unknown }) {
  let accountIds = parseJsonArray(input.accountIds);
  const phones = parseJsonArray(input.phones);

  if (accountIds.length === 0 && phones.length > 0) {
    const accounts = await prisma.account.findMany({ where: { phone: { in: phones } } });
    accountIds = accounts.map((a) => a.id);
  }

  accountIds = [...new Set(accountIds)];
  if (accountIds.length === 0) return { error: "No sender accounts: pass accountIds[] or legacy phones[]" } as const;

  const accounts = await prisma.account.findMany({ where: { id: { in: accountIds } } });
  if (accounts.length === 0) return { error: "Sender accounts not found" } as const;

  const resolvedPhones = accounts.map((a) => a.phone).filter((p): p is string => !!p);
  return { accountIds: accounts.map((a) => a.id), phones: resolvedPhones } as const;
}

/** Живые счётчики из recipients — единый источник истины, кэш не врёт. */
async function liveCounts(campaignIds: string[]) {
  const groups = await prisma.campaignRecipient.groupBy({
    by: ["campaignId", "status"],
    where: { campaignId: { in: campaignIds } },
    _count: true
  });
  const map = new Map<string, { sent: number; pending: number; failed: number }>();
  for (const id of campaignIds) map.set(id, { sent: 0, pending: 0, failed: 0 });
  for (const g of groups) {
    const entry = map.get(g.campaignId)!;
    if (g.status === "SENT") entry.sent += g._count;
    else if (g.status === "FAILED") entry.failed += g._count;
    else entry.pending += g._count; // PENDING + SENDING считаются ожидающими
  }
  return map;
}

/** Сверяет кэшированные sent/pending/failed с реальностью. */
export async function recalcCampaignCounters(campaignId: string) {
  const counts = await liveCounts([campaignId]);
  const c = counts.get(campaignId)!;
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { sent: c.sent, pending: c.pending, failed: c.failed }
  });
  return c;
}

function toDto(c: any, counts?: { sent: number; pending: number; failed: number }) {
  return {
    id: c.id,
    name: c.name,
    phone: parseJsonArray(c.phones),
    accountIds: parseJsonArray(c.accountIds ?? "[]"),
    message: c.message,
    group: c.groupName,
    groupId: c.groupId,
    nextAction: c.nextAction,
    sent: counts ? counts.sent : c.sent,
    pending: counts ? counts.pending : c.pending,
    failed: counts ? counts.failed : c.failed,
    isPaused: c.isPaused,
    minInterval: c.minInterval,
    maxInterval: c.maxInterval,
    sendFrom: c.sendFrom,
    sendTo: c.sendTo,
    status: c.status
  };
}

// GET all campaigns (с живыми счётчиками)
router.get("/", async (req, res) => {
  try {
    const campaigns = await prisma.campaign.findMany({ orderBy: { createdAt: "desc" } });
    const counts = await liveCounts(campaigns.map((c) => c.id));
    res.json(campaigns.map((c) => toDto(c, counts.get(c.id))));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET журнал доставки одной кампании (для таблицы + отладки FAILED)
router.get("/:id/recipients", async (req, res) => {
  const { id } = req.params;
  const status = typeof req.query.status === "string" ? req.query.status.toUpperCase() : undefined;
  const take = Math.min(parseInt(String(req.query.take ?? "200"), 10) || 200, 1000);
  const skip = parseInt(String(req.query.skip ?? "0"), 10) || 0;
  try {
    const campaign = await prisma.campaign.findUnique({ where: { id } });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    const rows = await prisma.campaignRecipient.findMany({
      where: { campaignId: id, ...(status && ["PENDING", "SENDING", "SENT", "FAILED"].includes(status) ? { status } : {}) },
      include: { contact: { select: { name: true, phone: true } } },
      orderBy: [{ sentAt: "desc" }, { updatedAt: "desc" }],
      take,
      skip
    });
    const total = await prisma.campaignRecipient.count({ where: { campaignId: id } });
    res.json({
      total,
      items: rows.map((r) => ({
        contactName: r.contact.name,
        contactPhone: r.contact.phone,
        status: r.status,
        senderPhone: r.senderPhone,
        sentAt: r.sentAt,
        attempts: r.attempts,
        error: r.error,
        text: r.sentText
      }))
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET выгрузка журнала в XLSX: кому / дошло ли / с какого номера / когда / текст
router.get("/:id/export.xlsx", async (req, res) => {
  const { id } = req.params;
  try {
    const campaign = await prisma.campaign.findUnique({ where: { id } });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    const rows = await prisma.campaignRecipient.findMany({
      where: { campaignId: id },
      include: { contact: { select: { name: true, phone: true } } },
      orderBy: { contact: { phone: "asc" } }
    });

    const wb = new ExcelJS.Workbook();
    wb.creator = "whatsapp-sender";
    const ws = wb.addWorksheet("delivery_log");
    ws.columns = [
      { header: "Контакт (имя)", key: "name", width: 24 },
      { header: "Контакт (телефон)", key: "phone", width: 20 },
      { header: "Статус", key: "status", width: 14 },
      { header: "Дошло", key: "delivered", width: 10 },
      { header: "Номер отправителя", key: "sender", width: 20 },
      { header: "Время отправки", key: "sentAt", width: 22 },
      { header: "Попыток", key: "attempts", width: 10 },
      { header: "Ошибка", key: "error", width: 30 },
      { header: "Текст сообщения", key: "text", width: 60 }
    ];
    for (const r of rows) {
      ws.addRow({
        name: r.contact.name ?? "",
        phone: r.contact.phone ?? "",
        status: r.status,
        delivered: r.status === "SENT" ? "да" : "нет",
        sender: r.senderPhone ?? "",
        sentAt: r.sentAt ? r.sentAt.toISOString() : "",
        attempts: r.attempts,
        error: r.error ?? "",
        text: r.sentText ?? ""
      });
    }
    ws.getRow(1).font = { bold: true };

    const safeName = campaign.name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 50) || "campaign";
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="campaign-${safeName}-${id.slice(0, 8)}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST create campaign — всё в одной транзакции: либо кампания+получатели, либо ничего
router.post("/", async (req, res) => {
  const { name, phones, accountIds, message, groupId, minInterval, maxInterval, sendFrom, sendTo } = req.body;

  if (!name || !message || !groupId || (!phones && !accountIds)) {
    return res.status(400).json({ error: "Missing required fields (name, phones|accountIds, message, groupId)" });
  }

  const iv = validateIntervals(minInterval ?? 600, maxInterval ?? 1200);
  if ("error" in iv) return res.status(400).json({ error: iv.error });
  const tw = validateTimeWindow(sendFrom, sendTo);
  if (tw.error) return res.status(400).json({ error: tw.error });

  try {
    const senders = await resolveSenders({ accountIds, phones });
    if ("error" in senders) return res.status(400).json({ error: senders.error });

    const subGroup = await prisma.subGroup.findUnique({
      where: { id: groupId },
      include: { contacts: { select: { id: true } } }
    });
    if (!subGroup) return res.status(404).json({ error: "Subgroup not found" });
    if (subGroup.contacts.length === 0) return res.status(400).json({ error: "Subgroup contains no contacts" });

    const created = await prisma.$transaction(async (tx) => {
      const campaign = await tx.campaign.create({
        data: {
          name,
          phones: JSON.stringify(senders.phones),
          accountIds: JSON.stringify(senders.accountIds),
          message,
          groupName: subGroup.name,
          groupId,
          minInterval: iv.min,
          maxInterval: iv.max,
          sendFrom: tw.sendFrom,
          sendTo: tw.sendTo,
          sent: 0,
          pending: subGroup.contacts.length,
          failed: 0,
          isPaused: true,
          status: "DRAFT"
        }
      });
      await tx.campaignRecipient.createMany({
        data: subGroup.contacts.map((c) => ({ campaignId: campaign.id, contactId: c.id, status: "PENDING" }))
      });
      return campaign;
    });

    res.status(201).json(toDto(created, { sent: 0, pending: subGroup.contacts.length, failed: 0 }));
  } catch (err: any) {
    console.error("Error creating campaign:", err);
    res.status(500).json({ error: err.message });
  }
});

// PUT update campaign
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const { name, phones, accountIds, message, minInterval, maxInterval, sendFrom, sendTo } = req.body;

  if (!name || !message || (!phones && !accountIds)) {
    return res.status(400).json({ error: "Missing required fields (name, phones|accountIds, message)" });
  }
  const iv = validateIntervals(minInterval, maxInterval);
  if ("error" in iv) return res.status(400).json({ error: iv.error });
  const tw = validateTimeWindow(sendFrom ?? undefined, sendTo ?? undefined);
  if (tw.error) return res.status(400).json({ error: tw.error });
  // PUT требует полные значения окон, а не частичные — иначе легко сохранить "08:00"/undefined
  if (req.body.sendFrom !== undefined && !HHMM_RE.test(req.body.sendFrom)) {
    return res.status(400).json({ error: "sendFrom/sendTo must be HH:MM (00:00-23:59)" });
  }
  if (req.body.sendTo !== undefined && !HHMM_RE.test(req.body.sendTo)) {
    return res.status(400).json({ error: "sendFrom/sendTo must be HH:MM (00:00-23:59)" });
  }

  try {
    const existing = await prisma.campaign.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Campaign not found" });

    const senders = await resolveSenders({ accountIds, phones });
    if ("error" in senders) return res.status(400).json({ error: senders.error });

    const updated = await prisma.campaign.update({
      where: { id },
      data: {
        name,
        phones: JSON.stringify(senders.phones),
        accountIds: JSON.stringify(senders.accountIds),
        message,
        minInterval: iv.min,
        maxInterval: iv.max,
        sendFrom: req.body.sendFrom ?? existing.sendFrom,
        sendTo: req.body.sendTo ?? existing.sendTo
      }
    });
    const counts = await liveCounts([id]);
    notifyCampaign(id, updated.status);
    res.json(toDto(updated, counts.get(id)));
  } catch (err: any) {
    console.error("Error updating campaign:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST start campaign
router.post("/:id/start", async (req, res) => {
  const { id } = req.params;
  try {
    const campaign = await prisma.campaign.findUnique({ where: { id } });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    const counts = await liveCounts([id]);
    const live = counts.get(id)!;
    if (live.pending <= 0) return res.status(400).json({ error: "No pending contacts to send to" });

    const updated = await prisma.campaign.update({
      where: { id },
      data: { isPaused: false, status: "RUNNING", nextAction: new Date(), sent: live.sent, pending: live.pending, failed: live.failed }
    });
    notifyCampaign(id, "RUNNING");
    res.json({ message: "Campaign started", status: updated.status, isPaused: updated.isPaused });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST pause campaign
router.post("/:id/pause", async (req, res) => {
  const { id } = req.params;
  try {
    const campaign = await prisma.campaign.findUnique({ where: { id } });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    // Перед паузой сверяем кэш, чтобы деталка не показывала старые цифры
    await recalcCampaignCounters(id).catch(() => undefined);
    const updated = await prisma.campaign.update({
      where: { id },
      data: { isPaused: true, status: "PAUSED" }
    });
    notifyCampaign(id, "PAUSED");
    res.json({ message: "Campaign paused", status: updated.status, isPaused: updated.isPaused });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE campaign
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.campaign.delete({ where: { id } });
    notifyCampaign(id, "DELETED");
    res.json({ message: "Campaign deleted successfully" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
