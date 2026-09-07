/**
 * Рассылка WS-событий кампаний без циклических импортов.
 * server.ts регистрирует реальный broadcaster, routes/scheduler только вызывают notify.
 */
type Broadcaster = (data: any) => void;

let broadcaster: Broadcaster | null = null;

export function setCampaignBroadcaster(fn: Broadcaster) {
  broadcaster = fn;
}

export function notifyCampaign(campaignId: string, status: string, extra: Record<string, any> = {}) {
  if (!broadcaster) return;
  try {
    broadcaster({ type: "campaign", id: campaignId, status, ...extra });
  } catch {
    // WS-уведомления best-effort: никогда не роняем API/шедулер из-за сокета
  }
}
