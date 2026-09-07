import { prisma } from "../db.js";
import { wsManager } from "../whatsapp.js";
import { localDayKey, localTimeHHMM } from "../lib/time.js";

/** How many times a recipient is tried before it is written off as FAILED. */
const MAX_ATTEMPTS = Number(process.env.MAX_SEND_ATTEMPTS) || 3;

/** First retry waits this long; each further retry doubles it. */
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS) || 5 * 60 * 1000;

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

      // No `pending` filter here: a campaign whose counter has drifted still
      // needs a tick to notice it has run out of recipients and complete.
      const runningCampaigns = await prisma.campaign.findMany({
        where: {
          status: "RUNNING",
          isPaused: false
        }
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

  /**
   * Zeroes `todaySent` for every account still stamped with an earlier day.
   * Running this on each tick means the rollover happens on the first tick after
   * local midnight and cannot be missed by a restart.
   */
  private async rollOverDailyCounters() {
    const today = localDayKey(new Date());
    const stale = await prisma.account.updateMany({
      where: {
        OR: [{ todaySentDay: null }, { todaySentDay: { not: today } }]
      },
      data: { todaySent: 0, todaySentDay: today }
    });
    if (stale.count > 0) {
      console.log(`[Scheduler] Daily counters reset for ${stale.count} account(s) — new day ${today}.`);
    }
  }

  private async processCampaign(campaign: any) {
    const now = new Date();

    // 1. Campaign-level gate: a scheduled start, or a delay parked outside
    //    working hours. Per-message pacing no longer lives here — it is per
    //    account, so several senders can be in flight at once.
    if (campaign.nextAction && new Date(campaign.nextAction) > now) {
      return;
    }

    // 2. Check work hours (sendFrom - sendTo) against the local clock
    const currentTimeStr = localTimeHHMM(now);
    const { sendFrom, sendTo } = campaign;

    if (sendFrom && sendTo) {
      if (sendFrom <= sendTo) {
        // Normal range: e.g. 08:00 to 20:00
        if (currentTimeStr < sendFrom || currentTimeStr > sendTo) {
          await this.delayCampaignToStartHours(campaign, now);
          return;
        }
      } else {
        // Overnight range: e.g. 20:00 to 08:00
        if (currentTimeStr < sendFrom && currentTimeStr > sendTo) {
          await this.delayCampaignToStartHours(campaign, now);
          return;
        }
      }
    }

    // 3. Completion is decided by the recipient rows, not the cached counter,
    //    so a drifted `pending` can never strand a campaign in RUNNING.
    const remaining = await prisma.campaignRecipient.count({
      where: { campaignId: campaign.id, status: "PENDING" }
    });

    if (remaining === 0) {
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: {
          status: "COMPLETED",
          isPaused: true,
          pending: 0,
          nextAction: null
        }
      });
      console.log(`[Scheduler] Campaign "${campaign.name}" completed.`);
      return;
    }

    // 4. Determine which sending accounts are usable right now
    let senderPhones: string[] = [];
    try {
      senderPhones = JSON.parse(campaign.phones);
    } catch (e) {
      senderPhones = [];
    }

    if (senderPhones.length === 0) {
      console.warn(`[Scheduler] Campaign "${campaign.name}" has no sender phone numbers.`);
      // Pause campaign due to configuration error
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { isPaused: true, status: "PAUSED" }
      });
      return;
    }

    const senderAccounts = await prisma.account.findMany({
      where: { phone: { in: senderPhones }, status: "CONNECTED" }
    });

    const connected = senderAccounts.filter((acc) => wsManager.getClient(acc.id) !== undefined);
    if (connected.length === 0) {
      console.warn(
        `[Scheduler] No connected WhatsApp profiles available for campaign "${campaign.name}". Senders: ${senderPhones.join(", ")}`
      );
      return;
    }

    // A dailyLimit of 0 means "no limit", which is the schema default.
    const withinLimit = connected.filter((acc) => acc.dailyLimit <= 0 || acc.todaySent < acc.dailyLimit);
    if (withinLimit.length === 0) {
      console.log(
        `[Scheduler] Campaign "${campaign.name}" is idle — every sender has reached its daily limit. Resumes after local midnight.`
      );
      return;
    }

    // Accounts still cooling down from their previous message sit this tick out.
    const available = withinLimit.filter(
      (acc) => !acc.nextAvailableAt || new Date(acc.nextAvailableAt) <= now
    );
    if (available.length === 0) {
      return;
    }

    // 5. Claim one due recipient per available sender, so N connected accounts
    //    genuinely send N messages in parallel rather than taking turns.
    const recipients = await prisma.campaignRecipient.findMany({
      where: {
        campaignId: campaign.id,
        status: "PENDING",
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }]
      },
      include: { contact: true },
      take: available.length
    });

    if (recipients.length === 0) {
      // Everything left is still inside its retry backoff.
      return;
    }

    await Promise.allSettled(
      recipients.map((recipient, index) => this.deliver(campaign, available[index], recipient))
    );
  }

  /**
   * Sends one message and records the outcome. The sending account is paced
   * whether the send succeeded or not, so a failing account cannot spin.
   */
  private async deliver(campaign: any, sender: SenderAccount, recipient: any) {
    const client = wsManager.getClient(sender.id);
    if (!client) return;

    const finalMessage = this.renderMessage(campaign.message, recipient.contact);

    console.log(
      `[Scheduler] Sending message for Campaign "${campaign.name}" to ${recipient.contact.phone} via ${sender.phone}`
    );

    let sentSuccess = false;
    let errorMsg = "";

    try {
      const formattedPhone = recipient.contact.phone.replace(/\D/g, "");
      const whatsappId = `${formattedPhone}@c.us`;

      await client.sendMessage(whatsappId, finalMessage);
      sentSuccess = true;
    } catch (err: any) {
      console.error(`[Scheduler] Send failed to ${recipient.contact.phone}:`, err.message);
      errorMsg = err.message || "Unknown error";
    }

    const now = new Date();

    // Pace this account before anything else, so a throw below cannot leave it
    // free to fire again on the very next tick.
    const minSec = campaign.minInterval || 60;
    const maxSec = campaign.maxInterval || 120;
    const randomDelaySeconds = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;

    await prisma.account.update({
      where: { id: sender.id },
      data: {
        nextAvailableAt: new Date(now.getTime() + randomDelaySeconds * 1000),
        ...(sentSuccess
          ? {
              todaySent: { increment: 1 },
              totalSent: { increment: 1 },
              todaySentDay: localDayKey(now)
            }
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
          error: null
        }
      });
      // Atomic counters: several senders finish concurrently within one tick.
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
        data: { attempts, nextAttemptAt, error: errorMsg }
      });
      console.log(
        `[Scheduler] Attempt ${attempts}/${MAX_ATTEMPTS} failed for ${recipient.contact.phone}, retrying at ${nextAttemptAt.toISOString()}.`
      );
      return;
    }

    // Out of attempts — this one is terminal, and only now does it leave `pending`.
    await prisma.campaignRecipient.update({
      where: { id: recipient.id },
      data: { attempts, status: "FAILED", nextAttemptAt: null, sentAt: now, error: errorMsg }
    });
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { failed: { increment: 1 }, pending: { decrement: 1 } }
    });
    console.warn(
      `[Scheduler] Giving up on ${recipient.contact.phone} after ${attempts} attempts: ${errorMsg}`
    );
  }

  /** Substitutes {{variable}} placeholders from the contact's stored variables. */
  private renderMessage(template: string, contact: any): string {
    let contactVars: Record<string, string> = {};
    try {
      contactVars = JSON.parse(contact.variables || "{}");
    } catch (e) {
      contactVars = {};
    }

    // Add default name
    if (contact.name && !contactVars.name) {
      contactVars.name = contact.name;
    }

    let finalMessage = template;

    // Replace {{variable}} or {{field_X}}
    for (const [key, value] of Object.entries(contactVars)) {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, "gi");
      finalMessage = finalMessage.replace(regex, value || "");
    }

    // Fallback: replace any remaining {{field_X}} with empty string to avoid showing raw braces
    return finalMessage.replace(/\{\{\w+\}\}/g, "");
  }

  private async delayCampaignToStartHours(campaign: any, now: Date) {
    const [hours, minutes] = campaign.sendFrom.split(":").map(Number);
    const scheduledDate = new Date(now);
    scheduledDate.setHours(hours, minutes, 0, 0);

    // If scheduled time has already passed today, set it to tomorrow
    if (scheduledDate < now) {
      scheduledDate.setDate(scheduledDate.getDate() + 1);
    }

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        nextAction: scheduledDate
      }
    });
    console.log(`[Scheduler] Delayed campaign "${campaign.name}" to start hours at ${scheduledDate.toISOString()}`);
  }
}

export const campaignScheduler = new CampaignScheduler();
export default campaignScheduler;
