/** What the desktop app (electron/preload.cjs) exposes. Undefined in a normal browser. */
export type ChannelState = {
  unread: number; // -1 = unread without a count
  title: string;
  favicon: string;
  loading: boolean;
  crashed: boolean;
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
};

export type Bounds = { x: number; y: number; width: number; height: number };
export type ChannelAction = "reload" | "back" | "forward" | "home" | "devtools" | "signout" | "zoom-in" | "zoom-out" | "zoom-reset";

interface DesktopApi {
  desktop: true;
  comms: {
    sync: () => Promise<Record<string, ChannelState>>;
    state: () => Promise<Record<string, ChannelState>>;
    show: (id: string, bounds: Bounds) => void;
    bounds: (bounds: Bounds) => void;
    hide: () => void;
    action: (id: string, action: ChannelAction) => Promise<boolean>;
    onState: (cb: (s: Record<string, ChannelState>) => void) => () => void;
    onOpen: (cb: (id: string) => void) => () => void;
  };
  openExternal: (url: string) => void;
}

export const desktop = (window as unknown as { studioDesktop?: DesktopApi }).studioDesktop;
export const isDesktop = Boolean(desktop);

/** Popular channels. Several accounts of the same service are fine: each gets its own profile. */
export const PRESETS: { kind: string; name: string; url: string; color: string; group: string }[] = [
  { kind: "whatsapp", name: "WhatsApp", url: "https://web.whatsapp.com/", color: "#25D366", group: "Messaging" },
  { kind: "messenger", name: "Messenger", url: "https://www.facebook.com/messages/", color: "#0084FF", group: "Messaging" },
  { kind: "instagram", name: "Instagram", url: "https://www.instagram.com/direct/inbox/", color: "#E1306C", group: "Messaging" },
  { kind: "telegram", name: "Telegram", url: "https://web.telegram.org/a/", color: "#26A5E4", group: "Messaging" },
  { kind: "discord", name: "Discord", url: "https://discord.com/app", color: "#5865F2", group: "Messaging" },
  { kind: "linkedin", name: "LinkedIn", url: "https://www.linkedin.com/messaging/", color: "#0A66C2", group: "Messaging" },
  { kind: "x", name: "X", url: "https://x.com/messages", color: "#111111", group: "Messaging" },
  { kind: "gmail", name: "Gmail", url: "https://mail.google.com/mail/", color: "#EA4335", group: "Email" },
  { kind: "outlook", name: "Outlook", url: "https://outlook.live.com/mail/", color: "#0078D4", group: "Email" },
  { kind: "outlook-work", name: "Outlook (work)", url: "https://outlook.office.com/mail/", color: "#0F6CBD", group: "Email" },
  { kind: "hostinger-mail", name: "Hostinger Mail", url: "https://mail.hostinger.com/", color: "#673DE6", group: "Email" },
  { kind: "zoho", name: "Zoho Mail", url: "https://mail.zoho.com/", color: "#E42527", group: "Email" },
  { kind: "slack", name: "Slack", url: "https://app.slack.com/client", color: "#4A154B", group: "Team" },
  { kind: "teams", name: "Teams", url: "https://teams.microsoft.com/", color: "#5B5FC7", group: "Team" },
  { kind: "gchat", name: "Google Chat", url: "https://chat.google.com/", color: "#00AC47", group: "Team" },
  { kind: "upwork", name: "Upwork", url: "https://www.upwork.com/ab/messages/", color: "#14A800", group: "Clients" },
  { kind: "fiverr", name: "Fiverr", url: "https://www.fiverr.com/inbox", color: "#1DBF73", group: "Clients" },
  { kind: "gbp", name: "Google Business", url: "https://business.google.com/", color: "#4285F4", group: "Clients" },
];
