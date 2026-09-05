export interface WhatsAppProfile {
  id: string;
  phone: string | null;
  name: string;
  proxy: string;
  status: "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "BANNED";
  todaySent: number;
  dailyLimit: number;
  totalSent: number;
  qr?: string | null;
  /** Epoch ms after which the current QR handshake is abandoned. */
  qrExpiresAt?: number | null;
  /** True while a headless browser is alive for this profile. */
  running?: boolean;
  /** Profiles created by the QR page, discarded again if never scanned. */
  isDraft?: boolean;
  lastError?: string | null;
  selected?: boolean;
}

export interface Contact {
  id: string;
  name: string;
  phone: string;
  variables: Record<string, string>;
  whatsappStatus?: "unknown" | "checking" | "exists" | "not_found";
}

export interface SubGroup {
  id: string;
  name: string;
  contacts: Contact[];
}

export interface ContactGroup {
  id: string;
  name: string;
  subGroups: SubGroup[];
  expanded?: boolean;
}

export interface Campaign {
  id: string;
  name: string;
  phone: string[];
  message: string;
  group: string;
  groupId: string;
  nextAction: string | null;
  nextActionTime: string;
  sent: number;
  pending: number;
  failed: number;
  isPaused: boolean;
  minInterval?: number;
  maxInterval?: number;
  sendFrom?: string;
  sendTo?: string;
  status: string;
}

export interface Proxy {
  id: string;
  value: string;
  createdAt: string;
}

export interface Template {
  id: string;
  name: string;
  body: string;
  variables: string[];
}
