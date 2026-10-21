"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import ActivityTimeline from "@/components/florist/ActivityTimeline";
import {
  businessHoursLabel,
  channelLabel,
  computePerformance,
  formatDate,
  formatDateTime,
  formatMoney,
  formatMoneySum,
  legLabel,
  payoutStatusBadgeCls,
  pctLabel,
  tierBadgeCls,
  tierReviewRecommended,
  type FloristStatsRow,
} from "@/components/florist/floristOps";
import OutreachSendPanel from "@/components/OutreachSendPanel";
import IssueCardForm from "@/components/payments/IssueCardForm";
import StatTile from "@/components/StatTile";
import Badge, { assignmentStatusBadge, orderStatusBadge } from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import {
  IconAlertTriangle,
  IconCheckCircle,
  IconCreditCard,
  IconMapPin,
  IconShoppingCart,
  IconStar,
  IconXCircle,
} from "@/components/icons";
import { computeActivation } from "@/lib/floristActivation";
import { orderTone, toneRowClass } from "@/lib/orderVisual";
import { floristAppUrl } from "@/lib/hostRouting";
import type { OrderStatus } from "@/lib/orderStatus";
import { LOCALES, type Locale } from "@/lib/i18n";
import { LIFECYCLE_STAGES, STAGE_LABEL } from "@/lib/pipeline";
import { buildTimeline, earliestPendingFollowUp } from "@/lib/timeline";
import type {
  AppSettings,
  City,
  Florist,
  FloristMeeting,
  FloristNote,
  LifecycleStage,
  OrderAssignment,
  Outreach,
  Payout,
} from "@/lib/types";

// Tier 5 ("Provisional") is deliberately absent: it is MINTED by a cold-offer
// accept, never chosen by hand.
const TRUST_TIERS = ["1", "2", "3", "4"] as const;

/** What each code MEANS, next to the code itself.
 *
 * A bare "1"/"2"/"3"/"4" is how tier 1 came to be set to 100/0 without anyone
 * noticing that every florist-facing screen still said 70/30: the dropdown gave
 * a staffer no way to see what they were choosing, and the splits are editable
 * from /settings at any time. The split is stated here so the two cannot drift
 * silently again.
 *
 * NOTE these are the DOCUMENTED defaults, not a live read — if someone edits a
 * split under /settings, update this map with it. */
const TRUST_TIER_LABEL: Record<(typeof TRUST_TIERS)[number], string> = {
  "1": "Trusted (100/0, paid in full on accept, photo still required)",
  "2": "Known (70/30)",
  "3": "New (0/100)",
  "4": "Flagged (held)",
};
const SOURCES = ["existing", "known", "new"] as const;

/** Preset delivery radii (km) — the operational range we actually see in
 *  practice. Not exhaustive: a florist's stored value that doesn't match one
 *  of these is kept as an extra, clearly-labeled option (see opRadius's
 *  <select> below) so switching to a dropdown never silently changes data. */
const RADIUS_PRESETS_KM = [5, 10, 15, 20, 30, 50, 75, 100] as const;

/** Preset daily order capacity — same "preserve the odd stored value" rule
 *  as RADIUS_PRESETS_KM above. */
const CAPACITY_PRESETS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 30, 50] as const;

/** Common payout_terms strings seen in practice (see
 *  supabase/seed/2026-07-13-florist-demo.sql) plus the brief's suggested
 *  operational buckets. This is presentation only — payout_terms stays a
 *  free string column server-side; a non-matching stored value is preserved
 *  as an extra option rather than coerced into one of these. */
const PAYOUT_TERMS_PRESETS = ["70/30 on accept", "70/30 card", "manual", "invoice/monthly"] as const;

/** A few common business-hours shapes, written in the same day-token
 *  convention documented in floristOps.ts's businessHoursLabel (e.g.
 *  "mon_fri" -> "Mon–Fri"). This is an additive convenience selector — the
 *  JSON textarea underneath stays the source of truth and keeps its own
 *  validation in saveOperational; picking "Custom" (or editing after picking
 *  a preset) just leaves the textarea alone. */
const HOURS_PRESETS: { key: string; label: string; value: Record<string, string> }[] = [
  { key: "mon_fri_9_5", label: "Mon–Fri 9–5", value: { mon_fri: "09:00-17:00" } },
  { key: "mon_sat_9_6", label: "Mon–Sat 9–6", value: { mon_sat: "09:00-18:00" } },
  { key: "daily_9_5", label: "Every day 9–5", value: { daily: "09:00-17:00" } },
];

/** Order-independent JSON compare, used only to figure out which (if any)
 *  HOURS_PRESETS entry the current textarea contents match, so the preset
 *  <select> above it can reflect "Custom" vs a known preset without
 *  re-implementing JSON validation (that stays in saveOperational). */
function canonicalHoursJson(value: Record<string, string>): string {
  return JSON.stringify(value, Object.keys(value).sort());
}
function matchingHoursPresetKey(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "custom";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "custom";
  const current = canonicalHoursJson(parsed as Record<string, string>);
  const match = HOURS_PRESETS.find((p) => canonicalHoursJson(p.value) === current);
  return match?.key ?? "custom";
}

/** A card that collapses so secondary/baseline detail sits below the fold —
 * mirrors components/orders/OrderDetailClient.tsx's own local CollapseCard
 * (duplicated rather than imported, same "colocate near the screen that uses
 * it" convention this file already follows for its formatting helpers). */
function CollapseCard({
  title,
  peek,
  open = false,
  children,
}: {
  title: React.ReactNode;
  peek?: string;
  open?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className="card card-collapse" open={open}>
      <summary>
        {title}
        {peek ? <span className="peek">· {peek}</span> : null}
        <span className="chev" aria-hidden="true">›</span>
      </summary>
      <div className="collapse-body">{children}</div>
    </details>
  );
}

/** Display names for the florist's preferred language, keyed by locale code —
 * mirrors LOCALES from lib/i18n. Shown to staff in the operational form. */
const LOCALE_LABEL: Record<Locale, string> = {
  en: "English",
  fr: "Français",
  es: "Español",
  it: "Italiano",
  de: "Deutsch",
  pt: "Português",
};

/** Nested-select row shape from the server page's `order_assignments.select("*,
 * orders(id, order_name, status, delivery_at, delivery_area))")`. */
export type AssignmentRow = OrderAssignment & {
  orders: {
    id: string;
    order_name: string | null;
    status: OrderStatus;
    delivery_at: string | null;
    delivery_area: string | null;
  } | null;
};

/** Nested-select row shape from the server page's `payouts.select("*,
 * order_assignments(order_id, orders(order_name)))")`. */
export type PayoutRow = Payout & {
  order_assignments: {
    order_id: string;
    orders: { order_name: string | null } | null;
  } | null;
};

export default function FloristCardClient({
  florist,
  city,
  settings,
  outreach,
  notes,
  meetings,
  assignments,
  payouts,
  hasLogin,
  stats,
  recentIssueCount,
  canViewAs = false,
  canSeeOperational,
  canIssueCard = false,
  isAdmin = false,
}: {
  florist: Florist;
  city: City | null;
  settings: AppSettings | null;
  outreach: Outreach[];
  notes: FloristNote[];
  meetings: FloristMeeting[];
  assignments: AssignmentRow[];
  payouts: PayoutRow[];
  hasLogin: boolean;
  stats: FloristStatsRow | null;
  recentIssueCount: number;
  /** Whether the current staff user (ops/admin) may open the read-only "view as
   *  florist" support session. */
  canViewAs?: boolean;
  canSeeOperational: boolean;
  /** Whether the current staff user (admin only) may issue an ad-hoc card. */
  canIssueCard?: boolean;
  /** Admin — required for the test-shop toggle, which decides whether test mode
   *  sends this florist REAL mail with a WORKING login link. */
  isAdmin?: boolean;
}) {
  const router = useRouter();
  const refresh = () => router.refresh();

  const timeline = useMemo(() => buildTimeline(outreach, notes, meetings), [outreach, notes, meetings]);
  const followUp = useMemo(() => earliestPendingFollowUp(meetings), [meetings]);
  const performance = useMemo(() => computePerformance(assignments), [assignments]);
  const totalPaidLabel = useMemo(
    () =>
      formatMoneySum(
        payouts
          .filter((p) => p.status === "issued" || p.status === "paid")
          .map((p) => ({ amount: p.amount, currency: p.currency }))
      ),
    [payouts]
  );
  const activation = useMemo(
    () => computeActivation({ delivery_radius_km: florist.delivery_radius_km, trust_tier: florist.trust_tier }, hasLogin),
    [florist.delivery_radius_km, florist.trust_tier, hasLogin]
  );
  const tierReviewHint = useMemo(
    () => tierReviewRecommended(assignments, recentIssueCount),
    [assignments, recentIssueCount]
  );

  // Operational vitals for the lead stat row — load right now + money owed.
  const activeOrders = useMemo(() => assignments.filter((a) => a.status === "accepted").length, [assignments]);
  const pendingOffers = useMemo(
    () => assignments.filter((a) => ["candidate", "queued", "sent", "opened"].includes(a.status)).length,
    [assignments]
  );
  const owedNowLabel = useMemo(
    () =>
      formatMoneySum(
        payouts
          .filter((p) => p.status === "pending" || p.status === "issued" || p.status === "held")
          .map((p) => ({ amount: p.amount, currency: p.currency }))
      ),
    [payouts]
  );

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  // Note form
  const [noteBody, setNoteBody] = useState("");
  // Meeting form
  const [mTitle, setMTitle] = useState("");
  const [mDate, setMDate] = useState("");
  const [mOutcome, setMOutcome] = useState("");
  const [mFollowUp, setMFollowUp] = useState("");

  // Operational form (Sprint 3) — trust_tier, delivery_radius_km,
  // capacity_per_day, business_hours, payout_terms, source. Not
  // preferred_channel/onboarded_at — those stay read-only/derived.
  const [opTier, setOpTier] = useState(florist.trust_tier ?? "");
  const [opRadius, setOpRadius] = useState(florist.delivery_radius_km != null ? String(florist.delivery_radius_km) : "");
  const [opCapacity, setOpCapacity] = useState(florist.capacity_per_day != null ? String(florist.capacity_per_day) : "");
  const [opHours, setOpHours] = useState(JSON.stringify(florist.business_hours ?? {}, null, 2));
  const opHoursPresetKey = useMemo(() => matchingHoursPresetKey(opHours), [opHours]);
  const [opPayoutTerms, setOpPayoutTerms] = useState(florist.payout_terms ?? "");
  const [opSource, setOpSource] = useState(florist.source ?? "");
  const [opLocale, setOpLocale] = useState(florist.locale ?? "");
  const [opFloristNumber, setOpFloristNumber] = useState(florist.florist_number != null ? String(florist.florist_number) : "");
  const [opReason, setOpReason] = useState("");

  // Contact/basic-info inline edit (header) — gated on canSeeOperational, same as
  // the Operational section below.
  const [editingDetails, setEditingDetails] = useState(false);
  const [dName, setDName] = useState(florist.name);
  const [dAddress, setDAddress] = useState(florist.address ?? "");
  const [dEmail, setDEmail] = useState(florist.email ?? "");
  const [dPhoneWeb, setDPhoneWeb] = useState(florist.phone_web ?? "");
  const [dPhoneMaps, setDPhoneMaps] = useState(florist.phone_maps ?? "");
  const [dOwnerName, setDOwnerName] = useState(florist.owner_name ?? "");
  const [dWebsiteUrl, setDWebsiteUrl] = useState(florist.website_url ?? "");

  // The join link, for sending again. Its own message state next to the button,
  // the same shape as the magic link below — the two are neighbours in the UI
  // and behave the same way, so they should read the same way in the code.
  const [joinMsg, setJoinMsg] = useState<string | null>(null);
  async function copyJoinLink() {
    setJoinMsg(null);
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch("/api/florists/join-link", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ floristId: florist.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j.message || j.error || `Request failed (${res.status}).`); return; }
      // Copy first, report second: if the clipboard is unavailable the florist
      // still needs to see the URL rather than a success message and no link.
      let copied = true;
      try { await navigator.clipboard.writeText(j.joinUrl); } catch { copied = false; }
      const until = j.expiresAt ? ` Valid until ${new Date(j.expiresAt).toLocaleDateString()}.` : "";
      const fresh = j.minted ? " A new link was created, so any older one has stopped working." : "";
      const already = j.joined ? " Note: this shop has already joined, so the link opens their details rather than a fresh sign-up." : "";
      setJoinMsg(copied ? `Copied.${until}${fresh}${already}` : `${j.joinUrl}${until}${fresh}${already}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Request failed.");
    } finally { setBusy(false); }
  }

  // Staff-sent sign-in link — its own state so the result ("Sent to …") shows
  // next to the button rather than through the shared error banner.
  const [magicMsg, setMagicMsg] = useState<string | null>(null);
  async function sendMagicLink() {
    setMagicMsg(null);
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch("/api/florists/magic-link", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ floristId: florist.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j.error || `Request failed (${res.status}).`); return; }
      setMagicMsg(
        j.placeholder
          ? `Sent to ${j.to} — test mode, so the link is inert. Flag this florist as a test shop to send a working one.`
          : `Sent to ${j.to}.`
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Request failed.");
    } finally { setBusy(false); }
  }

  async function post(url: string, payload: unknown, reset?: (json?: Record<string, unknown>) => void) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j.error || `Request failed (${res.status}).`);
        return;
      }
      reset?.(j);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  const setStage = (stage: LifecycleStage) =>
    post("/api/florists/stage", { floristId: florist.id, stage });
  const addNote = () => {
    if (!noteBody.trim()) return;
    post("/api/florists/note", { floristId: florist.id, body: noteBody }, () => setNoteBody(""));
  };
  const logMeeting = () => {
    if (!mTitle.trim() || !mDate) return;
    post(
      "/api/florists/meeting",
      {
        floristId: florist.id,
        title: mTitle,
        meetingAt: mDate,
        outcome: mOutcome || undefined,
        nextFollowUpAt: mFollowUp || undefined,
      },
      () => {
        setMTitle("");
        setMDate("");
        setMOutcome("");
        setMFollowUp("");
      }
    );
  };

  const excluded = !!florist.excluded_at;
  const toggleExclude = () =>
    post("/api/florists/exclude", { floristId: florist.id, restore: excluded });

  // Read-only "view as florist" support session: mint the view-as cookie, then
  // open the florist app in a new tab so the console stays put. Actions there
  // are disabled by construction (staff can't write as a florist).
  const viewAs = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/staff/view-as", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ floristId: florist.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j.error || `Could not start view-as (${res.status}).`);
        return;
      }
      window.open(floristAppUrl(location.hostname), "_blank", "noopener,noreferrer");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start view-as.");
    } finally {
      setBusy(false);
    }
  };

  const saveOperational = () => {
    let business_hours: Record<string, unknown> | null = null;
    const trimmedHours = opHours.trim();
    try {
      business_hours = trimmedHours ? JSON.parse(trimmedHours) : null;
    } catch {
      setErr("Business hours must be valid JSON (e.g. {\"mon_fri\":\"09:00-20:00\"}).");
      return;
    }
    if (business_hours !== null && (typeof business_hours !== "object" || Array.isArray(business_hours))) {
      setErr("Business hours must be a JSON object, not an array.");
      return;
    }
    const trimmedRadius = opRadius.trim();
    const delivery_radius_km = trimmedRadius === "" ? null : Number(trimmedRadius);
    if (delivery_radius_km !== null && !(Number.isFinite(delivery_radius_km) && delivery_radius_km > 0)) {
      setErr("Delivery radius must be a positive number.");
      return;
    }
    const trimmedCapacity = opCapacity.trim();
    const capacity_per_day = trimmedCapacity === "" ? null : Number(trimmedCapacity);
    if (capacity_per_day !== null && !(Number.isInteger(capacity_per_day) && capacity_per_day > 0)) {
      setErr("Capacity must be a positive whole number.");
      return;
    }
    const trimmedFloristNumber = opFloristNumber.trim();
    const florist_number = trimmedFloristNumber === "" ? null : Number(trimmedFloristNumber);
    if (florist_number !== null && !(Number.isInteger(florist_number) && florist_number > 0)) {
      setErr("Florist ID must be a positive whole number.");
      return;
    }
    setErr(null);
    post(
      "/api/florists/operational",
      {
        floristId: florist.id,
        trust_tier: opTier || null,
        delivery_radius_km,
        capacity_per_day,
        business_hours,
        payout_terms: opPayoutTerms.trim() || null,
        source: opSource || null,
        locale: opLocale || null,
        florist_number,
        reason: opReason.trim() || undefined,
      },
      () => setOpReason("")
    );
  };

  // Florist ID: editable (see opFloristNumber, saved via saveOperational
  // like every other field in the Operational panel), but "Assign Florist
  // ID" stays as a convenience shortcut to mint one from the reserved DB
  // sequence when the field is empty. `post` already guards double-submit
  // the same way every other mutation on this card does (busy flips true
  // before the request goes out). opFloristNumber is local state seeded
  // once from `florist.florist_number`, so a successful mint wouldn't
  // otherwise show up in the input until some other prop change happened to
  // remount it — pull the minted value straight from the response instead.
  const assignFloristNumber = () =>
    post("/api/florists/assign-number", { floristId: florist.id }, (j) => {
      if (j && typeof j.florist_number === "number") setOpFloristNumber(String(j.florist_number));
    });

  const openDetailsEdit = () => {
    setDName(florist.name);
    setDAddress(florist.address ?? "");
    setDEmail(florist.email ?? "");
    setDPhoneWeb(florist.phone_web ?? "");
    setDPhoneMaps(florist.phone_maps ?? "");
    setDOwnerName(florist.owner_name ?? "");
    setDWebsiteUrl(florist.website_url ?? "");
    setErr(null);
    setEditingDetails(true);
  };

  const saveDetails = () => {
    if (!dName.trim()) {
      setErr("Name is required.");
      return;
    }
    post(
      "/api/florists/details",
      {
        floristId: florist.id,
        name: dName.trim(),
        address: dAddress.trim() || null,
        email: dEmail.trim() || null,
        phone_web: dPhoneWeb.trim() || null,
        phone_maps: dPhoneMaps.trim() || null,
        owner_name: dOwnerName.trim() || null,
        website_url: dWebsiteUrl.trim() || null,
      },
      () => setEditingDetails(false)
    );
  };

  const phone = florist.phone_web ?? florist.phone_maps;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <Link href="/florists" className="eyebrow">
        ← Florists
      </Link>

      {/* Header */}
      <div className="card mt-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {editingDetails ? (
                <input
                  value={dName}
                  onChange={(e) => setDName(e.target.value)}
                  className="rounded border border-line-strong px-1.5 py-0.5 text-xl font-semibold text-ink"
                  aria-label="Florist name"
                />
              ) : (
                <h1 className="text-xl font-semibold text-ink">{florist.name}</h1>
              )}
              {canSeeOperational && !editingDetails && (
                <button
                  type="button"
                  onClick={openDetailsEdit}
                  className="text-xs text-accent hover:underline"
                  aria-label="Edit florist details"
                >
                  ✎ Edit
                </button>
              )}
              <Badge info={{ cls: tierBadgeCls(florist.trust_tier), label: florist.trust_tier ?? "—" }} />
              <Badge info={{ cls: "badge-bloom", label: STAGE_LABEL[florist.lifecycle_stage] }} />
              <Badge
                info={
                  activation.activatable
                    ? { cls: "badge-accent", label: "Activatable" }
                    : { cls: "badge-neutral", label: "Not activatable" }
                }
              />
              {excluded && <Badge info={{ cls: "badge-crit", label: "Excluded" }} />}
            </div>
            <label className="mt-1.5 block text-xs text-ink-soft">
              Move to{" "}
              <select
                value={florist.lifecycle_stage}
                disabled={busy}
                onChange={(e) => setStage(e.target.value as LifecycleStage)}
                className="rounded border border-line-strong px-1.5 py-0.5 text-xs"
                aria-label="Change lifecycle stage"
              >
                {LIFECYCLE_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {STAGE_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            {editingDetails ? (
              <div className="mt-2 flex flex-col gap-1.5 text-xs">
                <label className="flex items-center gap-1.5">
                  Address
                  <input value={dAddress} onChange={(e) => setDAddress(e.target.value)} className="flex-1 rounded border border-line-strong px-1.5 py-0.5" />
                </label>
                <label className="flex items-center gap-1.5">
                  Email
                  <input value={dEmail} onChange={(e) => setDEmail(e.target.value)} className="flex-1 rounded border border-line-strong px-1.5 py-0.5" />
                </label>
                <label className="flex items-center gap-1.5">
                  Phone (website)
                  <input value={dPhoneWeb} onChange={(e) => setDPhoneWeb(e.target.value)} className="flex-1 rounded border border-line-strong px-1.5 py-0.5" />
                </label>
                <label className="flex items-center gap-1.5">
                  Phone (Maps)
                  <input value={dPhoneMaps} onChange={(e) => setDPhoneMaps(e.target.value)} className="flex-1 rounded border border-line-strong px-1.5 py-0.5" />
                </label>
                <label className="flex items-center gap-1.5">
                  Owner name
                  <input value={dOwnerName} onChange={(e) => setDOwnerName(e.target.value)} className="flex-1 rounded border border-line-strong px-1.5 py-0.5" />
                </label>
                <label className="flex items-center gap-1.5">
                  Website
                  <input value={dWebsiteUrl} onChange={(e) => setDWebsiteUrl(e.target.value)} className="flex-1 rounded border border-line-strong px-1.5 py-0.5" />
                </label>
                <div className="mt-1 flex gap-2">
                  <Button variant="solid" onClick={saveDetails} disabled={busy}>
                    Save
                  </Button>
                  <Button
                    variant="default"
                    onClick={() => {
                      setEditingDetails(false);
                      setErr(null);
                    }}
                    disabled={busy}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
                {florist.email && <span>✉ {florist.email}</span>}
                {phone && <span>☎ {phone}</span>}
                {florist.website_url && (
                  <a href={florist.website_url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                    🌐 website
                  </a>
                )}
                {florist.rating != null && <span>★ {florist.rating.toFixed(1)}</span>}
                {florist.is_ecommerce && <span>ecommerce ✓</span>}
              </div>
            )}
            {florist.shop_highlight && (
              <p className="mt-2 text-xs text-ink-soft">
                <span aria-hidden>✨ </span>
                <span className="italic">{florist.shop_highlight}</span>
              </p>
            )}
            {followUp && (
              <p className="mt-2 text-xs font-medium text-warn">
                ⏰ Follow-up due {formatDate(followUp.at)}
                {followUp.title ? ` — ${followUp.title}` : ""}
              </p>
            )}
            {city && (
              <p className="mt-1 text-[11px] text-ink-faint">
                {city.city}, {city.country}
              </p>
            )}
          </div>

          <div className="flex flex-shrink-0 flex-col items-end gap-2">
            {canViewAs && (
              <Button variant="default" onClick={viewAs} disabled={busy} title="Open the florist app as this florist sees it (read-only)">
                👁 View as florist
              </Button>
            )}
            <Button
              variant="default"
              onClick={copyJoinLink}
              disabled={busy}
              title="Copy this florist's join link, so you can send it to them yourself"
            >
              🔗 Copy join link
            </Button>
            {joinMsg && (
              <p className="max-w-[22rem] text-right text-[11px] leading-snug text-ink-soft" role="status">
                {joinMsg}
              </p>
            )}
            {excluded ? (
              <Button variant="default" onClick={toggleExclude} disabled={busy}>
                Restore florist
              </Button>
            ) : (
              <Button variant="warn" onClick={toggleExclude} disabled={busy}>
                Exclude florist
              </Button>
            )}
          </div>
        </div>
        {excluded && (
          <p className="mt-2 text-xs text-crit">
            Excluded {formatDate(florist.excluded_at)}
            {florist.exclusion_reason ? ` — ${florist.exclusion_reason}` : ""}. Hidden from matching until restored.
          </p>
        )}
        {err && <p className="mt-2 text-xs text-crit">{err}</p>}
      </div>

      {/* Lead operational vitals — load now + track record + money owed, first. */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Active orders" value={activeOrders} accent="emerald" icon={<IconShoppingCart className="h-4 w-4" />} />
        <StatTile label="Pending offers" value={pendingOffers} accent="amber" icon={<IconStar className="h-4 w-4" />} />
        <StatTile label="On-time rate" value={pctLabel(stats?.on_time_rate)} accent="indigo" icon={<IconMapPin className="h-4 w-4" />} />
        <StatTile label="Acceptance" value={pctLabel(stats?.acceptance_rate)} accent="emerald" icon={<IconCheckCircle className="h-4 w-4" />} />
        <StatTile label="Rating" value={florist.rating != null ? florist.rating.toFixed(1) : "—"} accent="amber" icon={<IconStar className="h-4 w-4" />} />
        <StatTile label="Owed now" value={owedNowLabel} accent="emerald" icon={<IconCreditCard className="h-4 w-4" />} />
      </div>
      <p className="mt-1.5 text-[11px] text-ink-faint">
        Owed now = pending, issued, or held payouts. Already-paid history lives in Payouts below.
      </p>

      {/* Body: fulfillment (primary) + CRM (secondary) */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="flex flex-col gap-4">
          {/* Current & recent orders — the operational reality, first (DOM order
              matches visual order so keyboard/SR focus lands here before the
              editable config below). */}
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div className="mini-h" style={{ padding: "14px 16px 10px" }}>
              Current &amp; recent orders
            </div>
            {assignments.length === 0 ? (
              <p style={{ padding: "0 16px 16px", color: "var(--ink-faint)", fontSize: ".9rem" }}>
                No orders assigned yet.
              </p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Status</th>
                    <th>Deliver</th>
                    <th>Offer</th>
                    <th>Payout</th>
                  </tr>
                </thead>
                <tbody>
                  {assignments.map((a) => (
                    <tr key={a.id} className={a.orders ? toneRowClass(orderTone({ status: a.orders.status, delivery_at: a.orders.delivery_at })) : ""}>
                      <td>
                        {a.orders ? (
                          <Link
                            href={`/orders/${a.orders.id}`}
                            style={{ fontWeight: 700, fontFamily: "var(--mono)" }}
                          >
                            {a.orders.order_name ?? a.orders.id.slice(0, 8)}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>{a.orders ? <Badge info={orderStatusBadge(a.orders.status)} /> : "—"}</td>
                      <td style={{ color: "var(--ink-soft)" }}>
                        {a.orders?.delivery_at
                          ? `${formatDateTime(a.orders.delivery_at)}${
                              a.orders.delivery_area ? ` · ${a.orders.delivery_area}` : ""
                            }`
                          : "—"}
                      </td>
                      <td>
                        <Badge info={assignmentStatusBadge(a.status)} />
                      </td>
                      <td>{formatMoney(a.payout_price, null)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Payouts — collapsed by default: "Owed now" above the fold in the
              lead stat row already answers "what's outstanding right now",
              so this history (mostly already-paid legs) is secondary. */}
          <CollapseCard
            title="Payouts"
            peek={payouts.length > 0 ? `${payouts.length} · ${totalPaidLabel} paid to date` : undefined}
          >
            {payouts.length === 0 ? (
              <p style={{ color: "var(--ink-faint)", fontSize: ".9rem" }}>No payouts yet.</p>
            ) : (
              <div className="flex flex-col">
                {payouts.map((p) => {
                  const orderName = p.order_assignments?.orders?.order_name ?? null;
                  return (
                    <div key={p.id} className="tx" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span>
                          {legLabel(p.leg)}
                          {orderName ? ` · ${orderName}` : ""}
                        </span>
                        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <b>{formatMoney(p.amount, p.currency)}</b>
                          <Badge info={{ cls: payoutStatusBadgeCls(p.status), label: p.status }} />
                        </span>
                      </div>
                      <div style={{ color: "var(--ink-faint)", fontSize: ".72rem" }}>
                        {formatDateTime(p.created_at)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CollapseCard>

          {/* Operational facts — editable. Ops/Admin only: the write API
              (POST /api/florists/operational) already requires the same
              roles, so hide the section rather than show controls that
              would just 403. Collapsed by default UNLESS the florist isn't
              activatable yet — then it opens automatically so the blocking
              checklist item is visible without a click (the header badge
              already flags "Not activatable"; this is where staff fix it). */}
          {canSeeOperational && (
          <CollapseCard
            title="Operational"
            peek={activation.activatable ? "Activatable" : "Not activatable — see checklist"}
            open={!activation.activatable}
          >
            <ul className="mb-3 space-y-0.5 text-xs text-ink-soft">
              {activation.checklist.map((c) => (
                <li key={c.label} className={c.met ? "text-ink-soft" : "text-crit"}>
                  {c.met ? "✓" : "✗"} {c.label}
                </li>
              ))}
            </ul>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="text-[11px] text-ink-soft">
                Trust tier
                <select
                  value={opTier}
                  onChange={(e) => setOpTier(e.target.value)}
                  disabled={busy}
                  className="mt-0.5 w-full rounded border border-line-strong px-2 py-1 text-sm"
                >
                  <option value="">—</option>
                  {TRUST_TIERS.map((t) => (
                    <option key={t} value={t}>
                      {t} · {TRUST_TIER_LABEL[t]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[11px] text-ink-soft">
                Source
                <select
                  value={opSource}
                  onChange={(e) => setOpSource(e.target.value)}
                  disabled={busy}
                  className="mt-0.5 w-full rounded border border-line-strong px-2 py-1 text-sm"
                >
                  <option value="">—</option>
                  {SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[11px] text-ink-soft">
                Language
                <select
                  value={opLocale}
                  onChange={(e) => setOpLocale(e.target.value)}
                  disabled={busy}
                  className="mt-0.5 w-full rounded border border-line-strong px-2 py-1 text-sm"
                  aria-label="Preferred language for this florist's app and emails"
                >
                  <option value="">— (defaults to English)</option>
                  {LOCALES.map((l) => (
                    <option key={l} value={l}>
                      {LOCALE_LABEL[l]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[11px] text-ink-soft">
                Delivery radius (km)
                <select
                  value={opRadius}
                  onChange={(e) => setOpRadius(e.target.value)}
                  disabled={busy}
                  className="mt-0.5 w-full rounded border border-line-strong px-2 py-1 text-sm"
                  aria-label="Delivery radius, in kilometers"
                >
                  <option value="">— (unknown)</option>
                  {RADIUS_PRESETS_KM.map((km) => (
                    <option key={km} value={String(km)}>
                      {km} km
                    </option>
                  ))}
                  {opRadius !== "" && !RADIUS_PRESETS_KM.some((km) => String(km) === opRadius) && (
                    <option value={opRadius}>{opRadius} km (current, custom)</option>
                  )}
                </select>
              </label>
              <label className="text-[11px] text-ink-soft">
                Capacity per day
                <select
                  value={opCapacity}
                  onChange={(e) => setOpCapacity(e.target.value)}
                  disabled={busy}
                  className="mt-0.5 w-full rounded border border-line-strong px-2 py-1 text-sm"
                  aria-label="Capacity, orders per day"
                >
                  <option value="">— (unknown)</option>
                  {CAPACITY_PRESETS.map((n) => (
                    <option key={n} value={String(n)}>
                      {n} / day
                    </option>
                  ))}
                  {opCapacity !== "" && !CAPACITY_PRESETS.some((n) => String(n) === opCapacity) && (
                    <option value={opCapacity}>{opCapacity} / day (current, custom)</option>
                  )}
                </select>
              </label>
              <label className="text-[11px] text-ink-soft">
                Payout terms
                <select
                  value={opPayoutTerms}
                  onChange={(e) => setOpPayoutTerms(e.target.value)}
                  disabled={busy}
                  className="mt-0.5 w-full rounded border border-line-strong px-2 py-1 text-sm"
                  aria-label="Payout terms"
                >
                  <option value="">— (unknown)</option>
                  {PAYOUT_TERMS_PRESETS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                  {opPayoutTerms !== "" && !PAYOUT_TERMS_PRESETS.includes(opPayoutTerms as (typeof PAYOUT_TERMS_PRESETS)[number]) && (
                    <option value={opPayoutTerms}>{opPayoutTerms} (current, custom)</option>
                  )}
                </select>
              </label>
              <label className="text-[11px] text-ink-soft">
                Florist ID
                <div className="mt-0.5 flex items-center gap-2">
                  <input
                    value={opFloristNumber}
                    onChange={(e) => setOpFloristNumber(e.target.value)}
                    disabled={busy}
                    inputMode="numeric"
                    className="w-full rounded border border-line-strong px-2 py-1 text-sm"
                    aria-label="Florist ID"
                    placeholder="— (unassigned)"
                  />
                  {opFloristNumber.trim() === "" && (
                    <button
                      type="button"
                      onClick={assignFloristNumber}
                      disabled={busy}
                      className="flex-shrink-0 rounded-md border border-line-strong px-2 py-1 text-sm font-medium disabled:opacity-50"
                      aria-label="Assign Florist ID"
                    >
                      Assign
                    </button>
                  )}
                </div>
                <span className="mt-0.5 block text-[10px] text-ink-faint">
                  A Facundo ID sent to Shopify with each order. Auto-generate one, or type in a florist&apos;s real known ID.
                </span>
              </label>
              <label className="text-[11px] text-ink-soft sm:col-span-2">
                Business hours (JSON)
                <select
                  value={opHoursPresetKey}
                  onChange={(e) => {
                    const preset = HOURS_PRESETS.find((p) => p.key === e.target.value);
                    if (preset) setOpHours(JSON.stringify(preset.value, null, 2));
                  }}
                  disabled={busy}
                  className="mt-0.5 w-full rounded border border-line-strong px-2 py-1 text-sm"
                  aria-label="Business hours preset"
                >
                  <option value="custom">Custom (current — edit JSON below)</option>
                  {HOURS_PRESETS.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <textarea
                  value={opHours}
                  onChange={(e) => setOpHours(e.target.value)}
                  disabled={busy}
                  rows={2}
                  aria-label="Business hours JSON"
                  className="mt-1 w-full rounded border border-line-strong px-2 py-1 font-mono text-xs"
                />
              </label>
              <label className="text-[11px] text-ink-soft sm:col-span-2">
                Reason for change (optional, logged with tier changes)
                <input
                  value={opReason}
                  onChange={(e) => setOpReason(e.target.value)}
                  disabled={busy}
                  className="mt-0.5 w-full rounded border border-line-strong px-2 py-1 text-sm"
                />
              </label>
            </div>
            <button
              type="button"
              onClick={saveOperational}
              disabled={busy}
              className="mt-3 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Save operational details
            </button>

            {/* Staff-sent sign-in link. Separate from the offer email's CTA:
                this is "get this florist back into their account", or straight
                to one order, on request. */}
            <div className="mt-3 border-t border-line pt-3">
              <button
                type="button"
                onClick={sendMagicLink}
                disabled={busy || !florist.email}
                title={florist.email ? `Emails a one-tap sign-in link to ${florist.email}` : "This florist has no email address on file"}
                className="rounded-md border border-line-strong px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              >
                Email sign-in link
              </button>
              {magicMsg && <span className="ml-2 text-xs text-ink-soft">{magicMsg}</span>}
            </div>

            {/* TEST SHOP — admin only, and deliberately the last thing in this
                card. Turning it on makes test mode send this florist REAL email
                and SMS with a WORKING magic link (a login to this shop), and
                changes whether automatic matching can reach them. */}
            {isAdmin && (
              <div className="mt-3 border-t border-line pt-3">
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={florist.is_test_shop === true}
                    disabled={busy}
                    onChange={(e) => post("/api/florists/operational", { floristId: florist.id, is_test_shop: e.target.checked })}
                    className="mt-0.5"
                  />
                  <span>
                    <b>Test shop</b> — a shop we own, used to exercise the real order loop.
                    <span className="block text-xs text-ink-soft">
                      While test mode is on, this florist receives <b>real email and SMS at their own address</b> with a
                      <b> working sign-in link</b>, instead of the test inbox and inert links everyone else gets.
                      Automatic matching {settings?.test_shop_matching === "only" ? "currently routes ONLY to test shops" : "skips test shops"} —
                      change that in Settings.
                    </span>
                  </span>
                </label>
              </div>
            )}

            <dl className="kv mt-3">
              <dt>Hours</dt>
              <dd>{businessHoursLabel(florist.business_hours)}</dd>
              <dt>Channel</dt>
              <dd>{channelLabel(florist.preferred_channel)}</dd>
              <dt>Onboarded</dt>
              <dd>{formatDate(florist.onboarded_at)}</dd>
            </dl>
          </CollapseCard>
          )}

          {canIssueCard && (
            <div className="card">
              <div className="mini-h" style={{ marginBottom: 10 }}>Issue a card</div>
              <IssueCardForm florist={{ id: florist.id, name: florist.name }} />
            </div>
          )}

          {/* Performance + track record — merged under one collapsible: the
              lead stat row up top already surfaces on-time/acceptance/rating,
              so this full breakdown is baseline detail UNTIL the tier-review
              hint fires, at which point it opens automatically (the hint
              itself stays in the summary either way, since that's actionable,
              not baseline). */}
          <CollapseCard
            title={
              <span className="inline-flex items-center gap-2">
                Performance &amp; track record
                {tierReviewHint && <Badge info={{ cls: "badge-warn", label: "Tier review recommended" }} />}
              </span>
            }
            peek={`${performance.acceptanceRateLabel} accept · ${pctLabel(stats?.on_time_rate)} on-time`}
            open={tierReviewHint}
          >
            <div className="mini-h mb-2">Assignments</div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <StatTile
                label="Assigned"
                value={performance.assigned}
                accent="slate"
                icon={<IconShoppingCart className="h-4 w-4" />}
              />
              <StatTile
                label="Accepted"
                value={performance.accepted}
                accent="emerald"
                icon={<IconCheckCircle className="h-4 w-4" />}
              />
              <StatTile
                label="Delivered"
                value={performance.delivered}
                accent="indigo"
                icon={<IconMapPin className="h-4 w-4" />}
              />
              <StatTile
                label="Declined"
                value={performance.declined}
                accent="red"
                icon={<IconXCircle className="h-4 w-4" />}
              />
              <StatTile
                label="Acceptance"
                value={performance.acceptanceRateLabel}
                accent="amber"
                icon={<IconStar className="h-4 w-4" />}
              />
              <StatTile
                label="Total paid"
                value={totalPaidLabel}
                accent="emerald"
                icon={<IconCreditCard className="h-4 w-4" />}
              />
            </div>

            <div className="mini-h mb-2 mt-4">Track record (all-time)</div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatTile
                label="Acceptance rate"
                value={pctLabel(stats?.acceptance_rate)}
                accent="amber"
                icon={<IconStar className="h-4 w-4" />}
              />
              <StatTile
                label="On-time rate"
                value={pctLabel(stats?.on_time_rate)}
                accent="indigo"
                icon={<IconMapPin className="h-4 w-4" />}
              />
              <StatTile
                label="Declines"
                value={stats?.decline_count ?? 0}
                accent="red"
                icon={<IconXCircle className="h-4 w-4" />}
              />
              <StatTile
                label="Issues"
                value={stats?.issue_count ?? 0}
                accent="red"
                icon={<IconAlertTriangle className="h-4 w-4" />}
              />
            </div>
          </CollapseCard>

        </div>

        {/* CRM action rail */}
        <div className="space-y-4">
          <div className="card">
            <div className="mini-h mb-2">Activity timeline</div>
            <ActivityTimeline items={timeline} />
          </div>

          <CollapseCard title="Add note">
            <textarea
              value={noteBody}
              onChange={(e) => setNoteBody(e.target.value)}
              rows={2}
              placeholder="What happened…"
              className="w-full rounded border border-line-strong px-2 py-1 text-sm"
            />
            <button
              type="button"
              onClick={addNote}
              disabled={busy || !noteBody.trim()}
              className="mt-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Add note
            </button>
          </CollapseCard>

          <CollapseCard
            title="Meetings & follow-ups"
            peek={meetings.length > 0 ? `${meetings.length} logged` : undefined}
            open={!!followUp}
          >
            <input
              value={mTitle}
              onChange={(e) => setMTitle(e.target.value)}
              placeholder="Title (e.g. intro call)"
              className="w-full rounded border border-line-strong px-2 py-1 text-sm"
            />
            <label className="mt-2 block text-[11px] text-ink-soft">
              Date
              <input
                type="datetime-local"
                value={mDate}
                onChange={(e) => setMDate(e.target.value)}
                className="mt-0.5 w-full rounded border border-line-strong px-2 py-1 text-sm"
              />
            </label>
            <input
              value={mOutcome}
              onChange={(e) => setMOutcome(e.target.value)}
              placeholder="Outcome (optional)"
              className="mt-2 w-full rounded border border-line-strong px-2 py-1 text-sm"
            />
            <label className="mt-2 block text-[11px] text-ink-soft">
              Next follow-up (optional)
              <input
                type="datetime-local"
                value={mFollowUp}
                onChange={(e) => setMFollowUp(e.target.value)}
                className="mt-0.5 w-full rounded border border-line-strong px-2 py-1 text-sm"
              />
            </label>
            <button
              type="button"
              onClick={logMeeting}
              disabled={busy || !mTitle.trim() || !mDate}
              className="mt-2 rounded-md border border-line-strong px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-surface-2 disabled:opacity-50"
            >
              Log meeting
            </button>
          </CollapseCard>

          <div className="card">
            <div className="mini-h mb-2">Outreach</div>
            <p className="text-xs text-ink-soft">
              Compose a follow-up email — opens the send panel (test mode, edit-before-send) for
              this florist.
            </p>
            <button
              type="button"
              onClick={() => setComposing(true)}
              disabled={!florist.email}
              title={florist.email ? undefined : "No email address on file"}
              className="mt-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Compose email ✉
            </button>
          </div>
        </div>
      </div>

      {composing && (
        <OutreachSendPanel
          florists={[florist]}
          settings={settings}
          onClose={() => setComposing(false)}
          onSent={() => {
            setComposing(false);
            refresh();
          }}
          onDrafted={refresh}
        />
      )}
    </div>
  );
}
