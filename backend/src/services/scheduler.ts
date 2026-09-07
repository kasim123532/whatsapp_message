import { prisma } from "../db.js";
import { wsManager } from "../whatsapp.js";
import { localDayKey, localTimeHHMM } from "../lib/time.js";
import { notifyCampaign } from "../lib/campaignEvents.js";

/** How many times a recipient is tried before it is written off as FAILED. */
const MAX_ATTEMPTS = Number(process.env.MAX_SEND_ATTEMPTS) || 3;

/** First retry waits this long; each further retry doubles it. */
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS) || 5 * 60 * 1000;

/** SENDING старше этого считается зависшим (упал воркер) и помечается для разбора. */
const STALE_SENDING_MS = Number(process.env.STALE_SENDING_MS) || 5 * 60 * 1000;

function parseIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") {
    try {
      const p = JSON.parse(value);
      return Array.isArray(p) ? p.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

interface SenderAccount {
  id: string;
  phone: string | null;
  dailyLimit: number;
  todaySent: number;
}

class CampaignScheduler {
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  start() {
    if (this.timer) return;
    console.log("[Scheduler] Campaign engine started.");
    // Immediate first tick so a restart recovers stale SENDING rows within
    // seconds instead of waiting out the interval. Sends are still gated on
    // live CONNECTED clients, so nothing fires before WhatsApp is back.
    void this.tick().catch((err) => console.error("[Scheduler] Error in initial tick:", err));
    this.timer = setInterval(() => this.tick(), 5000); // Check every 5 seconds
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[Scheduler] Campaign engine stopped.");
    }
  }

  private async tick() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      await this.rollOverDailyCounters();
      await this.releaseStaleSending();

      const runningCampaigns = await prisma.campaign.findMany({
        where: { status: "RUNNING", isPaused: false }
      });

      for (const campaign of runningCampaigns) {
        await this.processCampaign(campaign);
      }
    } catch (err) {
      console.error("[Scheduler] Error in tick:", err);
    } finally {
      this.isProcessing = false;
    }
  }

  private async rollOverDailyCounters() {
    const today = localDayKey(new Date());
    const stale = await prisma.account.updateMany({
      where: { OR: [{ todaySentDay: null }, { todaySentDay: { not: today } }] },
      data: { todaySent: 0, todaySentDay: today }
    });
    if (stale.count > 0) {
      console.log(`[Scheduler] Daily counters reset for ${stale.count} account(s) — new day ${today}.`);
    }
  }

  /**
   * Разбирает зависшие SENDING (воркер упал между клеймом и записью SENT).
   * Такая строка, возможно, уже ушла в WhatsApp — слепой возврат в PENDING
   * давал silent-дубли. Поэтому: попытки исчерпаны → FAILED, иначе PENDING
   * с пометкой о возможном дубле и потраченной попыткой, чтобы повтор был
   * виден в журнале, а не выглядел как обычная очередь.
   */
  private async releaseStaleSending() {
    const cutoff = new Date(Date.now() - STALE_SENDING_MS);
    const stale = await prisma.campaignRecipient.findMany({
      where: { status: "SENDING", updatedAt: { lt: cutoff } },
      select: { id: true, attempts: true, campaignId: true }
    });
    if (stale.length === 0) return;
    let requeued = 0;
    let writtenOff = 0;
    for (const row of stale) {
      const attempts = row.attempts + 1;
      if (attempts < MAX_ATTEMPTS) {
        await prisma.campaignRecipient.update({
          where: { id: row.id },
          data: {
            status: "PENDING",
            attempts,
            nextAttemptAt: new Date(Date.now() + RETRY_BASE_MS),
            error: "Прервано перезапуском во время отправки — проверьте получение перед повтором (возможен дубль)"
          }
        });
        requeued++;
      } else {
        await prisma.campaignRecipient.update({
          where: { id: row.id },
          data: {
            status: "FAILED",
            attempts,
            nextAttemptAt: null,
            error: "Прервано перезапуском во время отправки, попытки исчерпаны — проверьте получение вручную"
          }
        });
        writtenOff++;
        await prisma.campaign
          .update({
            where: { id: row.campaignId },
            data: { failed: { increment: 1 }, pending: { decrement: 1 } }
          })
          .catch(() => undefined);
      }
    }
    console.log(
      `[Scheduler] Recovered ${stale.length} interrupted SENDING recipient(s): ${requeued} requeued, ${writtenOff} failed.`
    );
  }

  private async processCampaign(campaign: any) {
    const now = new Date();

    if (campaign.nextAction && new Date(campaign.nextAction) > now) return;

    const currentTimeStr = localTimeHHMM(now);
    const { sendFrom, sendTo } = campaign;

    if (sendFrom && sendTo) {
      if (sendFrom <= sendTo) {
        if (currentTimeStr < sendFrom || currentTimeStr > sendTo) {
          await this.delayCampaignToStartHours(campaign, now);
          return;
        }
      } else {
        if (currentTimeStr < sendFrom && currentTimeStr > sendTo) {
          await this.delayCampaignToStartHours(campaign, now);
          return;
        }
      }
    }

    // Завершение — по строкам (PENDING+SENDING), а не по кэшу, затем сверка кэша.
    const remaining = await prisma.campaignRecipient.count({
      where: { campaignId: campaign.id, status: { in: ["PENDING", "SENDING"] } }
    });

    if (remaining === 0) {
      const agg = await prisma.campaignRecipient.groupBy({
        by: ["status"],
        where: { campaignId: campaign.id },
        _count: true
      });
      let sent = 0;
      let failed = 0;
      for (const g of agg) {
        if (g.status === "SENT") sent += g._count;
        else if (g.status === "FAILED") failed += g._count;
      }
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: "COMPLETED", isPaused: true, pending: 0, sent, failed, nextAction: null }
      });
      console.log(`[Scheduler] Campaign "${campaign.name}" completed.`);
      notifyCampaign(campaign.id, "COMPLETED");
      return;
    }

    // Сендеры: основной ключ — Account.id, phones — legacy fallback.
    let accountIds = parseIds((campaign as any).accountIds);
    let senderPhones = parseIds(campaign.phones);
    let senderAccounts: any[] = [];
    if (accountIds.length > 0) {
      senderAccounts = await prisma.account.findMany({
        where: { id: { in: accountIds }, status: "CONNECTED" }
      });
    }
    if (senderAccounts.length === 0 && senderPhones.length > 0) {
      senderAccounts = await prisma.account.findMany({
        where: { phone: { in: senderPhones }, status: "CONNECTED" }
      });
    }

    if (accountIds.length === 0 && senderPhones.length === 0) {
      console.warn(`[Scheduler] Campaign "${campaign.name}" has no sender accounts.`);
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { isPaused: true, status: "PAUSED" }
      });
      notifyCampaign(campaign.id, "PAUSED");
      return;
    }

    const connected = senderAccounts.filter((acc) => wsManager.getClient(acc.id) !== undefined);
    if (connected.length === 0) return;

    const withinLimit = connected.filter((acc) => acc.dailyLimit <= 0 || acc.todaySent < acc.dailyLimit);
    if (withinLimit.length === 0) return;

    const available = withinLimit.filter(
      (acc) => !acc.nextAvailableAt || new Date(acc.nextAvailableAt) <= now
    );
    if (available.length === 0) return;

    // Атомарный клейм: переводим PENDING -> SENDING условным updateMany.
    // Выиграл только один воркер (count==1) — второй уже не заберёт ту же строку.
    const claimed: { recipient: any; sender: SenderAccount }[] = [];
    const candidates = await prisma.campaignRecipient.findMany({
      where: {
        campaignId: campaign.id,
        status: "PENDING",
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }]
      },
      include: { contact: true },
      orderBy: { updatedAt: "asc" },
      take: available.length
    });

    for (let i = 0; i < candidates.length && claimed.length < available.length; i++) {
      const cand = candidates[i];
      const sender = available[claimed.length];
      const res = await prisma.campaignRecipient.updateMany({
        where: { id: cand.id, status: "PENDING" },
        data: { status: "SENDING" }
      });
      if (res.count === 1) claimed.push({ recipient: cand, sender });
    }

    if (claimed.length === 0) return;

    const results = await Promise.allSettled(
      claimed.map(({ recipient, sender }) => this.deliver(campaign, sender, recipient))
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    notifyCampaign(campaign.id, "RUNNING", { delivered: ok });
  }

  private async deliver(campaign: any, sender: SenderAccount, recipient: any) {
    const client = wsManager.getClient(sender.id);
    if (!client) {
      // Сендер отвалился между клеймом и отправкой — вернуть в очередь
      await prisma.campaignRecipient.updateMany({
        where: { id: recipient.id, status: "SENDING" },
        data: { status: "PENDING" }
      });
      return;
    }

    const finalMessage = this.renderMessage(campaign.message, recipient.contact);

    console.log(
      `[Scheduler] Sending message for Campaign "${campaign.name}" to ${recipient.contact.phone} via ${sender.phone}`
    );

    let sentSuccess = false;
    let errorMsg = "";
    let sentMsgId: string | null = null;

    try {
      const formattedPhone = recipient.contact.phone.replace(/\D/g, "");
      const whatsappId = `${formattedPhone}@c.us`;
      const msg = await client.sendMessage(whatsappId, finalMessage);
      sentSuccess = true;
      try {
        const rawId = (msg as any)?.id;
        sentMsgId =
          typeof rawId === "string" ? rawId : typeof rawId?._serialized === "string" ? rawId._serialized : null;
      } catch {
        sentMsgId = null;
      }
    } catch (err: any) {
      console.error(`[Scheduler] Send failed to ${recipient.contact.phone}:`, err.message);
      errorMsg = err.message || "Unknown error";
    }

    const now = new Date();
    const minSec = campaign.minInterval || 60;
    const maxSec = campaign.maxInterval || 120;
    const randomDelaySeconds = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;

    await prisma.account.update({
      where: { id: sender.id },
      data: {
        nextAvailableAt: new Date(now.getTime() + randomDelaySeconds * 1000),
        ...(sentSuccess
          ? { todaySent: { increment: 1 }, totalSent: { increment: 1 }, todaySentDay: localDayKey(now) }
          : {})
      }
    });

    if (sentSuccess) {
      await prisma.campaignRecipient.update({
        where: { id: recipient.id },
        data: {
          status: "SENT",
          attempts: { increment: 1 },
          nextAttemptAt: null,
          sentAt: now,
          error: null,
          senderAccountId: sender.id,
          senderPhone: sender.phone,
          sentText: finalMessage,
          ...(sentMsgId ? { sentMsgId } : {})
        }
      });
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { sent: { increment: 1 }, pending: { decrement: 1 } }
      });
      return;
    }

    const attempts = recipient.attempts + 1;

    if (attempts < MAX_ATTEMPTS) {
      const backoffMs = RETRY_BASE_MS * Math.pow(2, attempts - 1);
      const nextAttemptAt = new Date(now.getTime() + backoffMs);
      await prisma.campaignRecipient.update({
        where: { id: recipient.id },
        data: { status: "PENDING", attempts, nextAttemptAt, error: errorMsg, sentText: finalMessage }
      });
      console.log(
        `[Scheduler] Attempt ${attempts}/${MAX_ATTEMPTS} failed for ${recipient.contact.phone}, retrying at ${nextAttemptAt.toISOString()}.`
      );
      return;
    }

    await prisma.campaignRecipient.update({
      where: { id: recipient.id },
      data: {
        attempts,
        status: "FAILED",
        nextAttemptAt: null,
        sentAt: now,
        error: errorMsg,
        senderPhone: sender.phone,
        senderAccountId: sender.id,
        sentText: finalMessage
      }
    });
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { failed: { increment: 1 }, pending: { decrement: 1 } }
    });
    console.warn(`[Scheduler] Giving up on ${recipient.contact.phone} after ${attempts} attempts: ${errorMsg}`);
  }

  private renderMessage(template: string, contact: any): string {
    let contactVars: Record<string, string> = {};
    try {
      contactVars = JSON.parse(contact.variables || "{}");
    } catch {
      contactVars = {};
    }
    if (contact.name && !contactVars.name) contactVars.name = contact.name;
    let finalMessage = template;
    for (const [key, value] of Object.entries(contactVars)) {
      // Ключи приходят из данных контакта — экранируем перед RegExp, иначе
      // ключ вроде "a)b" роняет replace, а crafted-ключ даёт ReDoS.
      const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`\\{\\{${safeKey}\\}\\}`, "gi");
      finalMessage = finalMessage.replace(regex, value || "");
    }
    return finalMessage.replace(/\{\{\w+\}\}/g, "");
  }

  private async delayCampaignToStartHours(campaign: any, now: Date) {
    const [hours, minutes] = String(campaign.sendFrom).split(":").map(Number);
    const scheduledDate = new Date(now);
    scheduledDate.setHours(hours, minutes, 0, 0);
    if (scheduledDate < now) scheduledDate.setDate(scheduledDate.getDate() + 1);
    await prisma.campaign.update({ where: { id: campaign.id }, data: { nextAction: scheduledDate } });
    console.log(`[Scheduler] Delayed campaign "${campaign.name}" to start hours at ${scheduledDate.toISOString()}`);
  }
}

export const campaignScheduler = new CampaignScheduler();
export default campaignScheduler;
