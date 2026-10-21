// Telling a human's click apart from a machine's.
//
// WHY THIS MATTERS MORE THAN IT LOOKS: a click is what exits the no-engagement
// track. A corporate link scanner (Outlook Safe Links, Proofpoint, Mimecast,
// Barracuda) opens every URL in every inbound email, within seconds, before any
// human has seen it. Counted as engagement, that single machine click:
//   - abandons the two remaining cold touches the prospect never received,
//   - fires "I can see someone from your shop opened the link I sent" at a
//     florist who did not open anything, and
//   - reports a click-through rate that is mostly robots.
// The first of those quietly costs us the prospect; the second is worse,
// because it is a claim about them that is false and that they can tell is false.
//
// Pure and alias-free so `node --test` reaches it. EMAIL ONLY, deliberately:
// SMS links go to a phone, not through a corporate mail gateway, and
// `short_links` stores no user-agent by design (see its migration — no IP, no
// UA, no per-click rows, so it needs no retention policy). Nothing here asks
// that decision to be reversed; the signals used are already in the Resend
// webhook payload and are evaluated in flight, never stored.

/** Substrings that identify a link scanner or a bot rather than a browser.
 * Matched case-insensitively against the click's user agent. */
const SCANNER_AGENTS = [
  // Microsoft Defender for Office / Safe Links
  "safelinks", "bingpreview", "microsoftpreview", "skypeuripreview",
  // Proofpoint, Mimecast, Barracuda, Cisco, Symantec, Forcepoint
  "proofpoint", "urldefense", "mimecast", "barracuda", "ironport",
  "symantec", "forcepoint", "trendmicro", "fireeye", "zscaler",
  // Google/Gmail image+link proxies and generic crawlers
  "googleimageproxy", "ggpht", "feedfetcher",
  // The delimiters matter: matching a bare "bot" would also hit any UA
  // containing "robot", and matching only "bot/" misses "Googlebot-Image/1.0".
  "googlebot", "crawler", "spider", "slurp",
  "bot/", "bot-", "bot;", "bot)", "bot ", "curl/", "wget/",
  "python-requests", "go-http-client", "java/", "libwww-perl", "okhttp",
  "headlesschrome", "phantomjs", "puppeteer", "playwright",
];

/** Below this, a click is treated as a machine opening the mail rather than a
 * person reading it.
 *
 * Five seconds is deliberately conservative. A scanner fires essentially at
 * delivery; a human has to receive a notification, unlock a phone or switch
 * windows, read enough to care, and then tap. Under five seconds that has not
 * happened. Set it much higher and we would start discarding real clicks from
 * someone already sitting in their inbox. */
export const MIN_HUMAN_DWELL_MS = 5_000;

export interface ClickSignals {
  userAgent?: string | null;
  /** When the click happened. */
  clickedAt?: string | number | null;
  /** When the message was delivered, if we have a `delivered` event for it. */
  deliveredAt?: string | number | null;
}

function ms(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

export function isScannerUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return SCANNER_AGENTS.some((s) => ua.includes(s));
}

/** True when this click was almost certainly a machine.
 *
 * FAILS OPEN — an absent user agent and an unknown delivery time mean "treat it
 * as human". A missed scanner costs us two cold touches for one prospect; a
 * discarded real click costs us the prospect entirely, because they showed
 * interest and we then went quiet on the cold track. Given the asymmetry, only
 * positive evidence of a machine counts. */
export function isMachineClick(signals: ClickSignals): boolean {
  if (isScannerUserAgent(signals.userAgent)) return true;

  const clicked = ms(signals.clickedAt);
  const delivered = ms(signals.deliveredAt);
  if (clicked === null || delivered === null) return false; // no evidence → human
  const dwell = clicked - delivered;
  // A negative dwell (clicked "before" delivery) is clock skew between the
  // provider's event timestamps, not a time traveller — no evidence either way.
  if (dwell < 0) return false;
  return dwell < MIN_HUMAN_DWELL_MS;
}

/** Pull the click signals out of a Resend `email.clicked` webhook payload.
 * Tolerates the several shapes the field has taken, and returns nulls rather
 * than throwing on anything unexpected. */
export function clickSignalsFromResend(body: unknown): ClickSignals {
  const data = (body as { data?: Record<string, unknown> })?.data ?? {};
  const click = (data.click ?? {}) as Record<string, unknown>;
  const ua =
    (typeof click.userAgent === "string" && click.userAgent) ||
    (typeof click.user_agent === "string" && click.user_agent) ||
    null;
  const at =
    (typeof click.timestamp === "string" && click.timestamp) ||
    (typeof data.created_at === "string" && (data.created_at as string)) ||
    null;
  return { userAgent: ua, clickedAt: at };
}
