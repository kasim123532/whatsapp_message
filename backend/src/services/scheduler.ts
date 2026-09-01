import { prisma } from "../db.js";
import { wsManager } from "../whatsapp.js";

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
      // Find all campaigns that are active
      const runningCampaigns = await prisma.campaign.findMany({
        where: {
          status: "RUNNING",
          isPaused: false,
          pending: { gt: 0 }
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

  private async processCampaign(campaign: any) {
    const now = new Date();

    // 1. Check if campaign is scheduled for the future
    if (campaign.nextAction && new Date(campaign.nextAction) > now) {
      return;
    }

    // 2. Check work hours (sendFrom - sendTo)
    const currentTimeStr = now.toTimeString().split(" ")[0].substring(0, 5); // "HH:MM"
    const { sendFrom, sendTo } = campaign;

    if (sendFrom && sendTo) {
      if (sendFrom <= sendTo) {
        // Normal range: e.g. 08:00 to 20:00
        if (currentTimeStr < sendFrom || currentTimeStr > sendTo) {
          // Outside of hours, delay next check to sendFrom time (either today or tomorrow)
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

    // 3. Find next pending recipient
    const recipient = await prisma.campaignRecipient.findFirst({
      where: {
        campaignId: campaign.id,
        status: "PENDING"
      },
      include: {
        contact: true
      }
    });

    if (!recipient) {
      // No more recipients, complete the campaign
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: {
          status: "COMPLETED",
          isPaused: true,
          nextAction: null
        }
      });
      console.log(`[Scheduler] Campaign "${campaign.name}" completed.`);
      return;
    }

    // 4. Determine sending accounts
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

    // Resolve sender phone numbers to account records, then filter to ones with a live client
    const senderAccounts = await prisma.account.findMany({
      where: { phone: { in: senderPhones }, status: "CONNECTED" }
    });
    const connectedSenders = senderAccounts.filter(acc => wsManager.getClient(acc.id) !== undefined);

    if (connectedSenders.length === 0) {
      console.warn(`[Scheduler] No connected WhatsApp profiles available for campaign "${campaign.name}". Senders: ${senderPhones.join(", ")}`);
      // Skip this tick, wait for connection
      return;
    }

    // Select a sender (randomly select one of the connected profiles to spread load)
    const selectedSender = connectedSenders[Math.floor(Math.random() * connectedSenders.length)];
    const selectedSenderPhone = selectedSender.phone!;
    const client = wsManager.getClient(selectedSender.id)!;

    // 5. Build message content by replacing variables
    let finalMessage = campaign.message;
    let contactVars: Record<string, string> = {};
    try {
      contactVars = JSON.parse(recipient.contact.variables || "{}");
    } catch (e) {
      contactVars = {};
    }

    // Add default name
    if (recipient.contact.name && !contactVars.name) {
      contactVars.name = recipient.contact.name;
    }

    // Replace {{variable}} or {{field_X}}
    for (const [key, value] of Object.entries(contactVars)) {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, "gi");
      finalMessage = finalMessage.replace(regex, value || "");
    }

    // Fallback: replace any remaining {{field_X}} with empty string to avoid showing raw braces
    finalMessage = finalMessage.replace(/\{\{\w+\}\}/g, "");

    // 6. Send message
    console.log(`[Scheduler] Sending message for Campaign "${campaign.name}" to ${recipient.contact.phone} via ${selectedSenderPhone}`);
    
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

    // 7. Update database status
    const status = sentSuccess ? "SENT" : "FAILED";
    await prisma.campaignRecipient.update({
      where: { id: recipient.id },
      data: {
        status,
        sentAt: now,
        error: errorMsg || null
      }
    });

    // Update campaign counters
    const updateData: any = {
      sent: campaign.sent + (sentSuccess ? 1 : 0),
      failed: campaign.failed + (sentSuccess ? 0 : 1),
      pending: campaign.pending - 1
    };

    // Update account sending stats
    if (sentSuccess) {
      await prisma.account.updateMany({
        where: { phone: selectedSenderPhone },
        data: {
          todaySent: { increment: 1 },
          totalSent: { increment: 1 }
        }
      });
    }

    // 8. Calculate next action time using random interval
    const minSec = campaign.minInterval || 60;
    const maxSec = campaign.maxInterval || 120;
    const randomDelaySeconds = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;
    const nextActionDate = new Date(now.getTime() + randomDelaySeconds * 1000);
    
    updateData.nextAction = nextActionDate;

    // Check if there are any pending remaining
    if (updateData.pending <= 0) {
      updateData.status = "COMPLETED";
      updateData.isPaused = true;
      updateData.nextAction = null;
      console.log(`[Scheduler] Campaign "${campaign.name}" completed.`);
    }

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: updateData
    });
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
