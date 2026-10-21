"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { OrderAssignment, OrderLineItem, OrderIssue, IssueMessage } from "@/lib/types";
import type { AcceptBlockReason } from "@/lib/lateAccept";
import Button from "@/components/ui/Button";
import PhotoGuide from "@/components/florist/PhotoGuide";
import { useAcceptOffer } from "@/components/florist/useAcceptOffer";
import { useViewAsReadOnly } from "@/components/florist/ViewAsContext";
import AcceptOfferFeedback from "@/components/florist/AcceptOfferFeedback";
import FloristOfferView from "@/components/florist/offer/FloristOfferView";
import OfferItems from "@/components/florist/offer/OfferItems";
import OfferCardMessage from "@/components/florist/offer/OfferCardMessage";
import { type PayoutSplit } from "@/components/florist/offer/OfferPayout";
import OrderTimeline from "@/components/florist/OrderTimeline";
import { euro, fmtKm, fmtDeliverBy, dialableNumber } from "@/components/florist/orderFormat";
import type { GreetingKey } from "@/lib/floristGreeting";
import { heldPanelVisible, type PhotoReview } from "@/lib/photoFeedback";
import CelebrationModal, { type Earned } from "@/components/florist/CelebrationModal";
import CardReveal from "@/components/florist/CardReveal";
import IssueThread from "@/components/issues/IssueThread";
import { useT } from "@/components/florist/LocaleProvider";
import { legLabel } from "@/components/florist/floristOps";

// `code` is the value actually sent to the server (→ decline_reason, shown
// verbatim on the staff order page — components/orders/OrderDetailClient.tsx)
// and MUST stay a stable English identifier across locales; `key` selects the
// translated button label under ui.orderDetail.detail.declineReasons.
const REASONS: { code: string; key: string }[] = [
  { code: "Price too low", key: "priceTooLow" },
  { code: "Too busy", key: "tooBusy" },
  { code: "Out of area", key: "outOfArea" },
  { code: "Can't source", key: "cantSource" },
  { code: "Too urgent", key: "tooUrgent" },
  { code: "On holiday", key: "onHoliday" },
];

// Why a florist is handing an already-accepted order back (→ /api/florist/release).
// Distinct from REASONS (which explains a pre-accept decline). Same code/key
// split and same reason: `code` lands in decline_reason unchanged.
const RELEASE_REASONS: { code: string; key: string }[] = [
  { code: "Can't fulfil in time", key: "cantFulfilInTime" },
  { code: "Out of stock", key: "outOfStock" },
  { code: "Emergency came up", key: "emergencyCameUp" },
  { code: "Accepted by mistake", key: "acceptedByMistake" },
  { code: "Other", key: "other" },
];

// Post-accept problems the florist can raise (→ /api/florist/issue). Opens an
// order_issues row for CX; does not change the order's stage. `type` is the
// value sent to the API (unchanged across locales); `key` selects the
// translated button label under ui.orderDetail.detail.issueReasons.
const ISSUE_REASONS: { key: string; type: string }[] = [
  { key: "missingIngredient", type: "missing_ingredient" },
  { key: "wrongAddress", type: "wrong_address" },
  { key: "outOfRange", type: "out_of_range" },
  { key: "recipientUnavailable", type: "recipient_unavailable" },
  { key: "damagedWrongRecipient", type: "damaged_wrong_recipient" },
  { key: "somethingElse", type: "other" },
];

interface Payment { id: string; leg: string; status: string; amount: number | null; rail: string | null; provider_ref: string | null }

// A payout you can tap through to reveal + charge a card (same gate as the
// payment page / balance).
function paymentHasCard(p: Payment): boolean {
  return p.rail === "card" && !!p.provider_ref && !String(p.provider_ref).startsWith("ledger:") && (p.status === "issued" || p.status === "paid");
}

// Build a one-line address from the stored JSON, tolerating key variants
// (address1/line1, zip/postal_code, country_code/country). Returns null when
// there's nothing usable.
function formatAddress(a: unknown): string | null {
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const line1 = str(o.address1) ?? str(o.line1) ?? str(o.street);
  const line2 = str(o.line2);
  // Real Shopify ingestion writes `postal` (see ingest-worker/src/shopify.ts);
  // the mock generator uses `zip` — accept both, plus `postal_code`.
  const cityZip = [str(o.zip) ?? str(o.postal_code) ?? str(o.postal), str(o.city)].filter(Boolean).join(" ");
  const parts = [line1, line2, cityZip || null, str(o.country_code) ?? str(o.country)].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** The recipient's phone, post-accept. Tapping COPIES the number rather than
 * dialling it — a deliberate product call (2026-09-14), not an oversight: a
 * `tel:` link is one tap to call on a handset but a dead click on any desktop
 * without a dialler app, and CX staff read this screen through view-as. Copying
 * behaves the same everywhere.
 *
 * The number is the button's own label, so if the clipboard is unavailable
 * (insecure context, permission denied) the florist can still read and type it.
 * That is why failure leaves the label alone rather than showing an error. */
function RecipientPhone({ display, copyValue }: { display: string; copyValue: string }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function copy() {
    // Optional-chain the whole call: `navigator.clipboard` is undefined on an
    // insecure origin, and writeText can still reject when it exists.
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(copyValue);
    } catch {
      return; // number stays on screen; nothing to apologise for
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      type="button"
      className="fc-addr-phone"
      onClick={copy}
      title={t("ui.orderDetail.detail.copyRecipientPhone")}
      aria-label={`${t("ui.orderDetail.detail.copyRecipientPhone")} ${display}`}
    >
      <span aria-hidden="true">📞</span>
      <span className="fc-addr-phone-n">{display}</span>
      <span className="fc-addr-phone-a">
        {copied ? `✓ ${t("ui.orderDetail.detail.recipientPhoneCopied")}` : t("ui.orderDetail.detail.copyRecipientPhone")}
      </span>
    </button>
  );
}

/** The facts a florist decides / delivers on, up front: distance · deliver-by ·
 * payout, then the address (area + "shown on accept" pre-accept; full address +
 * recipient + a copyable recipient phone once accepted — PII is nulled
 * server-side pre-accept). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- redacted server projection
function OrderFacts({ view, accepted, payout }: { view: any; accepted: boolean; payout: number | null }) {
  const { t } = useT();
  const fullAddress = accepted ? formatAddress(view.address) : null;
  // Shown on its own line rather than folded into the recipient hint: a florist
  // standing at a door that won't open needs it to stand out. Rendered even when
  // the address didn't format, which is exactly when it matters most. `display`
  // is the stored string as-is (what they read); the copied value is normalised.
  const phoneCopy = accepted ? dialableNumber(view.recipient_phone) : null;
  const { day, time } = fmtDeliverBy(view.delivery_at, t);
  return (
    <div className="ocard" style={{ display: "grid", gap: 10, padding: 12 }}>
      <h1 style={{ margin: 0, fontSize: "1.05rem", fontFamily: "var(--mono)" }}>{view.order_name ?? "—"}</h1>
      <div className="fc-facts">
        <div className="fc-fact">
          <div className="fc-fact-l">{t("ui.orderDetail.detail.distance")}</div>
          <div className="fc-fact-v">{view.distance_km != null ? fmtKm(view.distance_km) : "—"}</div>
        </div>
        <div className="fc-fact">
          <div className="fc-fact-l">{t("ui.orderDetail.detail.deliverBy")}</div>
          <div className="fc-fact-v">
            {day}
            {time && <small>{time}</small>}
          </div>
        </div>
        <div className="fc-fact accent">
          <div className="fc-fact-l">{t("ui.orderDetail.detail.yourPayout")}</div>
          <div className="fc-fact-v">{euro(payout)}</div>
        </div>
      </div>
      <div style={{ display: "grid", gap: 2 }}>
        {accepted ? (
          fullAddress ? (
            <>
              <div className="fc-addr">📍 {fullAddress}</div>
              {view.recipient && <div className="fc-addr-hint">{t("ui.orderDetail.detail.forRecipient", { recipient: view.recipient })}</div>}
            </>
          ) : (
            <div className="fc-addr-hint">{view.area ?? t("ui.orderDetail.detail.addressUnavailable")}</div>
          )
        ) : (
          <div className="fc-addr-hint">📍 {view.area ?? "—"} · {t("ui.orderDetail.detail.addressShownOnAccept")}</div>
        )}
        {phoneCopy && <RecipientPhone display={String(view.recipient_phone)} copyValue={phoneCopy} />}
        {/* `occasion` and `delivery_window` used to render here. Both are null
            on all 1000 sampled production orders, so neither ever appeared —
            dropped rather than carried forward as dead conditionals. */}
      </div>
    </div>
  );
}

/**
 * `view` is a redacted server-built projection of the order (address/recipient
 * nulled pre-accept). `orderOpen` reflects the ORDER's status (not the
 * assignment's) — true while it's still `received`/`matched`/`reaching_out`,
 * i.e. nobody else has taken it yet, which is what makes re-accepting a
 * declined assignment possible.
 */
export default function FloristOrderDetail({
  assignment,
  view,
  items,
  accepted,
  orderOpen,
  acceptBlock = null,
  deliveredPhotoKey = null,
  payments = [],
  orderId,
  issues = [],
  messages = [],
  payoutSplit = null,
  greetingKey = null,
  ownerName = null,
  photoReview = null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `view` is a redacted server-built projection (address nulled pre-accept)
}: { assignment: OrderAssignment; view: any; items: OrderLineItem[]; accepted: boolean; orderOpen: boolean; acceptBlock?: AcceptBlockReason | null; deliveredPhotoKey?: string | null; payments?: Payment[]; orderId?: string; issues?: OrderIssue[]; messages?: IssueMessage[]; payoutSplit?: PayoutSplit | null; greetingKey?: GreetingKey | null; ownerName?: string | null; photoReview?: PhotoReview | null }) {
  const { t } = useT();
  const router = useRouter();
  const readOnly = useViewAsReadOnly(); // staff view-as: disable all florist actions
  const [declining, setDeclining] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [heldNotice, setHeldNotice] = useState(false);
  // The reason from the most recent upload in THIS session. Takes precedence
  // over the server-rendered one, which is a render behind until refresh lands.
  const [liveReview, setLiveReview] = useState<PhotoReview | null>(null);
  const [celebration, setCelebration] = useState<Earned | null>(null);
  const { result, accept } = useAcceptOffer(setCelebration);
  // Effective lock for action controls — a real florist is never read-only.
  const locked = busy || readOnly;
  const acceptOffer = () => { if (!readOnly) accept(assignment.id); };

  // Mark this order's issues read once the florist opens it, then refresh so the
  // tab-bar unread badge (computed in the layout) updates too.
  const hasUnread = issues.some((i) => i.florist_unread);
  useEffect(() => {
    if (!orderId || !hasUnread) return;
    fetch("/api/florist/issue/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId }) })
      .then(() => router.refresh())
      .catch(() => {});
  }, [orderId, hasUnread, router]);

  async function reportIssue(type: string) {
    if (readOnly) return;
    setBusy(true);
    const res = await fetch("/api/florist/issue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assignmentId: assignment.id, type }) });
    setBusy(false);
    if (!res.ok) { alert((await res.json().catch(() => ({}))).error ?? t("ui.orderDetail.detail.errorReportProblem")); return; }
    setReporting(false);
    router.refresh();
  }

  async function respond(action: "decline", reason?: string) {
    if (readOnly) return;
    setBusy(true);
    const res = await fetch("/api/florist/respond", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assignmentId: assignment.id, action, reason }) });
    setBusy(false);
    if (!res.ok) alert((await res.json()).error ?? t("ui.orderDetail.detail.errorFailed")); else router.refresh();
  }
  async function release(reason: string) {
    if (readOnly) return;
    setBusy(true);
    const res = await fetch("/api/florist/release", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assignmentId: assignment.id, reason }) });
    setBusy(false);
    if (!res.ok) { alert((await res.json().catch(() => ({}))).error ?? t("ui.orderDetail.detail.errorGiveBack")); return; }
    setReleasing(false);
    router.refresh();
  }
  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    if (readOnly) return;
    const file = e.target.files?.[0]; if (!file) return;
    const fd = new FormData(); fd.append("assignmentId", assignment.id); fd.append("type", "delivered"); fd.append("file", file);
    // A doorstep photo over a phone connection takes seconds; without this the
    // button looked inert and invited a second tap (= a second upload).
    setUploading(true);
    try {
      const res = await fetch("/api/florist/photo", { method: "POST", body: fd });
      if (!res.ok) { alert((await res.json().catch(() => ({}))).error ?? t("ui.orderDetail.detail.errorUploadFailed")); return; }
      const body = (await res.json().catch(() => ({}))) as { earned?: Earned | null; held?: boolean; feedback?: PhotoReview | null };
      if (body.earned) {
        setCelebration(body.earned); // celebrate the 30% delivery leg
        // Clear BOTH bits of hold state. Forgetting `heldNotice` here left the
        // "under review" panel on screen after a re-upload had already released
        // the money -- and with `liveReview` gone it fell back to the generic
        // "we'll let you know", which is the one sentence this whole change
        // exists to stop showing when it isn't true.
        setLiveReview(null);
        setHeldNotice(false);
      }
      else if (body.held) {
        setHeldNotice(true); // 30% under review — no money yet
        // Show the reason straight away rather than making them reload to find
        // out anything more than "under review".
        setLiveReview(body.feedback ?? null);
      }
      router.refresh();
    } catch {
      alert(t("ui.orderDetail.detail.errorUploadFailed"));
    } finally {
      setUploading(false);
      // Let the same file be re-picked after a failure — the input keeps its
      // value otherwise and onChange never fires again.
      e.target.value = "";
    }
  }

  // Awaiting this florist's first response (normal accept/decline flow). Note
  // `expired` is NOT excluded here any more: a lapsed window doesn't close the
  // offer while the order is still unclaimed (lib/lateAccept.ts) — `acceptable`
  // below is what actually decides. Decline stays limited to a live offer.
  // Decline is offered whenever accept is. A lapsed offer stays acceptable
  // while the order is unclaimed (lib/lateAccept.ts), and showing Accept with
  // no way to refuse left the florist stuck between taking a late order and
  // ignoring it silently. `acceptable` below covers the lapsed case; the
  // status list still covers the pre-accept states where the order itself
  // isn't open yet (semi mode's `received`), which accept deliberately gates.
  const openForResponse = ["candidate", "queued", "sent", "opened"].includes(assignment.status);
  // The server evaluated the accept predicate for us (see the page). `null`
  // means the florist may accept right now — live OR lapsed.
  const acceptable = acceptBlock === null;
  const declinable = !accepted && (openForResponse || acceptable);
  // The offer's own window has run out, but they can still take it. Worth
  // saying explicitly, because the countdown has already hit zero on screen.
  const lapsedButAcceptable = acceptable && assignment.status === "expired";
  const pendingResponse = !accepted && (declinable || acceptable);
  // Declined, but the order hasn't been snapped up by anyone else yet — offer a way back in.
  const canReAccept = assignment.status === "declined" && orderOpen && acceptable;
  // Currently holding an accepted, not-yet-delivered order — can hand it back.
  const canGiveBack = assignment.status === "accepted";

  // This shop's tier pays the whole payout on accept, so there is NO delivery
  // leg to settle (lib/payoutMath.ts::isSinglePayment). The photo is still
  // required and still uploaded — it is proof of delivery — it just isn't
  // holding any money. Everything below that reasons about the delivery leg has
  // to know this, because the leg's ABSENCE would otherwise read exactly like a
  // leg that never released: an uploaded proof would show the "we couldn't
  // approve that photo" badge and re-offer the upload button forever.
  const singlePayment = payoutSplit?.singlePayment ?? false;
  // The delivery leg is "settled" once a delivery payout is held/issued/paid.
  // Until then (never uploaded, or a proof was rejected → failed) the florist can
  // (re-)upload. On a single-payment tier the PHOTO ITSELF is the settlement:
  // once we hold a delivered proof there is nothing further to wait for.
  const deliverySettled = singlePayment
    ? !!deliveredPhotoKey
    : payments.some((p) => p.leg === "delivery" && (p.status === "held" || p.status === "issued" || p.status === "paid"));
  // The actionable delivery leg's status — failed/clawed-back rows are history
  // (a rejected proof can coexist with a fresh one), so they must not be read
  // as "this leg is settled".
  const deliveryLegStatus =
    payments.find((p) => p.leg === "delivery" && p.status !== "failed" && p.status !== "clawed_back")?.status ?? null;
  // Why a held 30% is held, and whether another photo can still change it. The
  // in-session result (from the upload we just made) wins over the server's,
  // which is one router.refresh() behind.
  const review = liveReview ?? photoReview;

  // The pre-accept OFFER is the florist's decision moment and has its own
  // component tree (components/florist/offer/**). Everything else — the
  // post-accept work order, and terminal pre-accept states like reassigned —
  // keeps the original facts + line-item layout below.
  const showOffer = pendingResponse || canReAccept;

  // Actions live here, not in the offer tree: they own the fetches, the router
  // refresh and the view-as read-only lock, so the offer components stay
  // presentational. Stacked rather than side by side — "I can deliver this
  // order correctly" is far too long to sit next to its opposite on a phone.
  const offerActions = (
    <>
      {pendingResponse && (declining ? (
        <div className="ocard" style={{ display: "grid", gap: 8 }}>
          <div className="mini-h">{t("ui.orderDetail.detail.whyDeclining")}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {REASONS.map((r) => <button key={r.code} className="btn" disabled={locked} onClick={() => respond("decline", r.code)}>{t(`ui.orderDetail.detail.declineReasons.${r.key}`)}</button>)}
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {acceptable && (
            <Button variant="solid" disabled={locked || result.kind === "busy"} onClick={acceptOffer} style={{ justifyContent: "center" }}>
              {result.kind === "busy" ? t("ui.orderDetail.detail.accepting") : t("ui.offer.page.acceptCta")}
            </Button>
          )}
          {/* "I'd take it, but…" — the third thing a florist wants to say, and
              until now the only way to say it was to go quiet. Pure navigation:
              the offer is untouched (no state change, no countdown pause, no
              ticket), and the Q&A carries a back link straight to this order.
              A plain link rather than a Button so it prefetches and works
              under view-as, where every real action is locked. */}
          <Link
            href={`/florist/help?back=${encodeURIComponent(`/florist/orders/${assignment.id}`)}`}
            className="btn btn-ghost"
            style={{ justifyContent: "center" }}
          >
            {t("ui.offer.page.questionsCta")}
          </Link>
          {declinable && (
            <Button variant="warn" disabled={locked} onClick={() => setDeclining(true)} style={{ justifyContent: "center" }}>{t("ui.offer.page.declineCta")}</Button>
          )}
        </div>
      ))}

      {canReAccept && (
        <Button variant="solid" disabled={locked || result.kind === "busy"} onClick={acceptOffer} style={{ width: "100%", justifyContent: "center" }}>
          {result.kind === "busy" ? t("ui.orderDetail.detail.accepting") : t("ui.offer.page.reAcceptCta")}
        </Button>
      )}
    </>
  );

  return (
    <main className="ds page fc-readable" style={{ display: "grid", gap: 14 }}>
      <Link href="/florist" className="eyebrow">← {t("ui.orderDetail.detail.backToOrders")}</Link>

      {showOffer && (
        <FloristOfferView
          greetingKey={greetingKey}
          ownerName={ownerName}
          orderName={view.order_name ?? null}
          area={view.area ?? null}
          distanceKm={view.distance_km ?? null}
          deliveryAt={view.delivery_at ?? null}
          payout={assignment.payout_price}
          items={items}
          greeting={view.greeting ?? null}
          payoutSplit={payoutSplit}
          offerExpiresAt={assignment.offer_expires_at}
          stillAcceptableAfterExpiry={lapsedButAcceptable}
          actions={offerActions}
        />
      )}

      {!showOffer && (<>
      {/* The facts a florist decides / delivers on, first. */}
      <OrderFacts view={view} accepted={accepted} payout={assignment.payout_price} />

      {/* Same hierarchy as the pre-accept offer (components/florist/offer/**):
          bouquet first with a large photo, then everything else in the box,
          then the greeting card — so accepting doesn't reshuffle what the
          florist already read. */}
      <OfferItems items={items} />
      <OfferCardMessage greeting={view.greeting ?? null} />

      <div className="ocard payout">
        <span>{t("ui.orderDetail.detail.totalPayout")}</span>
        <b>{euro(assignment.payout_price)}</b>
      </div>

      {accepted && <OrderTimeline assignment={assignment} />}
      </>)}

      <AcceptOfferFeedback result={result} />

      {payments.length > 0 && (
        <div className="ocard" style={{ display: "grid", gap: 6 }}>
          <div className="mini-h">{t("ui.orderDetail.detail.payments")}</div>
          {payments.map((p) => {
            // See FloristBalance.tsx: accept/delivery stay translated, `manual`
            // (unreachable for a florist under the assignment-scoped payouts RLS
            // policy) falls back to the shared helper instead of being
            // mislabelled as the delivery leg.
            const legText = p.leg === "manual"
              ? legLabel(p.leg)
              : p.leg === "accept" ? t("ui.orderDetail.detail.legAccept") : t("ui.orderDetail.detail.legDelivery");
            const card = paymentHasCard(p);
            return (
              // The card is money the florist can spend right now, so it gets a
              // real button that reveals it IN PLACE. It used to be a 0.72rem
              // accent caption inside the row — you had to already know the row
              // was tappable, and then tap again on the payment page to reveal.
              // The row still links through to the payment record for the detail.
              <div key={p.id} style={{ display: "grid", gap: 8 }}>
                <Link href={`/florist/payments/${p.id}`} className="tx" style={{ cursor: "pointer" }}>
                  <span>{legText} · {p.status === "held" ? t("ui.orderDetail.detail.underReview") : p.status}</span>
                  <b>{euro(p.amount)}</b>
                </Link>
                {card && <CardReveal payoutId={p.id} />}
              </div>
            );
          })}
        </div>
      )}

      {canGiveBack && (releasing ? (
        <div className="ocard" style={{ display: "grid", gap: 8 }}>
          <div className="mini-h">{t("ui.orderDetail.detail.whyGivingBack")}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {RELEASE_REASONS.map((r) => <button key={r.code} className="btn" disabled={locked} onClick={() => release(r.code)}>{t(`ui.orderDetail.detail.releaseReasons.${r.key}`)}</button>)}
          </div>
          <button className="btn btn-ghost" disabled={busy} onClick={() => setReleasing(false)}>{t("ui.orderDetail.detail.cancel")}</button>
        </div>
      ) : (
        <button className="btn btn-ghost" style={{ justifySelf: "start" }} disabled={locked} onClick={() => setReleasing(true)}>
          ↩ {t("ui.orderDetail.detail.giveBack")}
        </button>
      ))}

      {accepted && (deliveredPhotoKey && deliverySettled ? (
        <div className="ocard" style={{ display: "grid", gap: 8, padding: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div className="mini-h">{t("ui.orderDetail.detail.deliveryProof")}</div>
            <span className="badge badge-accent">{t("ui.orderDetail.detail.delivered")}</span>
          </div>
          {/* Served by the florist-scoped photo route (ownership-checked). */}
          {/* eslint-disable-next-line @next/next/no-img-element -- R2-served blob, no next/image loader on Workers */}
          <img
            src={`/api/florist/photo?key=${encodeURIComponent(deliveredPhotoKey)}`}
            alt={t("ui.orderDetail.detail.deliveryProofAlt")}
            style={{ width: "100%", borderRadius: 10, display: "block" }}
          />
          {/* A split-tier shop reads its outcome in the money (the 30% landed,
              or the held panel below says why). A single-payment shop has no
              such signal — the payout closed on accept — so without this line
              the screen after upload is indistinguishable from the screen
              before it, and "did that go through?" is the obvious next thought.
              Say plainly that the proof is in and that the money was never
              waiting on it. */}
          {singlePayment && (
            <p style={{ fontSize: ".8rem", color: "var(--ink-soft)", margin: 0, lineHeight: 1.45 }}>
              {t("ui.orderDetail.detail.proofReceivedPaidInFull")}
            </p>
          )}
        </div>
      ) : (
        // No `capture` attr: lets the phone offer Camera OR Photo Library
        // instead of jumping straight into the camera. Re-uploadable if a prior
        // proof was rejected.
        <div style={{ display: "grid", gap: 10 }}>
          {deliveredPhotoKey && !deliverySettled && (
            <div className="badge badge-warn" style={{ justifySelf: "start" }}>{t("ui.orderDetail.detail.photoRejectedNotice")}</div>
          )}
          {/* How to shoot it, immediately above the button that opens the camera. */}
          <PhotoGuide singlePayment={singlePayment} />
          {/* A real primary button, not the dashed `.dropzone` this used to be:
              that rendered as faint 0.74rem mono text in a dashed box, which on
              a phone at the doorstep reads as a placeholder rather than the
              action that releases the remaining 30%. Still a <label> wrapping a
              hidden input — that's what opens the picker — so it carries an
              explicit button role for assistive tech. No `capture` attr: lets
              the phone offer Camera OR Photo Library. */}
          <label
            className="btn btn-solid btn-lg btn-block"
            role="button"
            tabIndex={readOnly || uploading ? -1 : 0}
            aria-disabled={readOnly || uploading}
            style={readOnly || uploading ? { opacity: 0.6, pointerEvents: "none" } : undefined}
          >
            {uploading ? t("ui.orderDetail.detail.uploadingDeliveryPhoto") : `⬆ ${t("ui.orderDetail.detail.uploadDeliveryPhoto")}`}
            <input type="file" accept="image/*" onChange={upload} disabled={readOnly || uploading} style={{ display: "none" }} />
          </label>
        </div>
      ))}

      {/* The rule itself is pure and unit-tested — lib/photoFeedback.ts —
          because `heldNotice` is client state that does not reset itself, and
          getting this wrong is silent and lands on the florist. */}
      {!singlePayment && heldPanelVisible({ accepted, sessionHeldNotice: heldNotice, deliveryStatus: deliveryLegStatus }) && (
        <div className="ocard" style={{ display: "grid", gap: 8, padding: 12, background: "color-mix(in srgb, var(--warn) 8%, transparent)", border: "1px solid var(--warn)" }}>
          <b style={{ color: "var(--warn)" }}>{t("ui.orderDetail.detail.deliverySubmittedTitle")}</b>
          {/* WHY it's parked. Without this the florist is told their money is
              waiting on a review, with nothing to act on and no way to tell
              whether acting would even help. `ourFault` is the case where our
              own checker never managed to look — say so plainly rather than
              leave them reading it as a judgement on their work. */}
          {review ? (
            <>
              <p style={{ fontSize: ".85rem", color: "var(--ink-soft)" }}>{t(`ui.orderDetail.detail.photoReason.${review.code}`)}</p>
              {review.missing.length > 0 && (
                <div style={{ display: "grid", gap: 4 }}>
                  <div className="mini-h">{t("ui.orderDetail.detail.photoMissingHeading")}</div>
                  <ul style={{ fontSize: ".82rem", color: "var(--ink-soft)", margin: 0, paddingInlineStart: "1.1rem" }}>
                    {review.missing.map((m) => <li key={m}>{m}</li>)}
                  </ul>
                </div>
              )}
              {review.canReupload ? (
                <>
                  <label
                    className="btn btn-solid btn-block"
                    role="button"
                    tabIndex={readOnly || uploading ? -1 : 0}
                    aria-disabled={readOnly || uploading}
                    style={readOnly || uploading ? { opacity: 0.6, pointerEvents: "none" } : undefined}
                  >
                    {uploading ? t("ui.orderDetail.detail.uploadingDeliveryPhoto") : `⬆ ${t("ui.orderDetail.detail.photoReupload")}`}
                    <input type="file" accept="image/*" onChange={upload} disabled={readOnly || uploading} style={{ display: "none" }} />
                  </label>
                  <p style={{ fontSize: ".78rem", color: "var(--ink-soft)", margin: 0 }}>
                    {t("ui.orderDetail.detail.photoAttemptsLeft", { n: review.attemptsLeft })}
                  </p>
                </>
              ) : (
                <p style={{ fontSize: ".85rem", color: "var(--ink-soft)", margin: 0 }}>{t("ui.orderDetail.detail.photoHumanReview")}</p>
              )}
            </>
          ) : (
            <p style={{ fontSize: ".85rem", color: "var(--ink-soft)", marginTop: 4 }}>{t("ui.orderDetail.detail.deliverySubmittedBody")}</p>
          )}
        </div>
      )}

      {/* Threads stay visible whenever the order has issues — even after a
          reassign flips this assignment to 'reassigned' — so the florist can
          always see the resolution. Reporting a NEW problem needs a live
          (accepted) order. */}
      {(accepted || issues.length > 0) && (
        <div style={{ display: "grid", gap: 10 }}>
          {issues.length > 0 && <div className="mini-h">{t("ui.orderDetail.detail.supportAndIssues")}</div>}
          {issues.map((iss) => (
            <IssueThread
              key={iss.id}
              issue={iss}
              messages={messages.filter((m) => m.issue_id === iss.id)}
              role="florist"
              replyUrl="/api/florist/issue/reply"
            />
          ))}
          {accepted && (
            <div className="ocard" style={{ display: "grid", gap: 8, padding: 12 }}>
              {reporting ? (
                <>
                  <div className="mini-h">{t("ui.orderDetail.detail.whatsTheProblem")}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {ISSUE_REASONS.map((r) => (
                      <button key={r.type} className="btn" disabled={locked} onClick={() => reportIssue(r.type)}>{t(`ui.orderDetail.detail.issueReasons.${r.key}`)}</button>
                    ))}
                  </div>
                  <button className="btn btn-ghost" onClick={() => setReporting(false)}>{t("ui.orderDetail.detail.cancel")}</button>
                </>
              ) : (
                // `id` is the anchor OrderChat's "Something's wrong" chip
                // scrolls to and clicks: only this control can open an
                // order_issue, so the chat hands the florist over rather than
                // turning a real problem into a message nobody acts on.
                <button id="fc-report-problem" className="btn btn-ghost" style={{ justifySelf: "start" }} disabled={locked} onClick={() => setReporting(true)}>
                  ⚠ {issues.length > 0 ? t("ui.orderDetail.detail.reportAnotherProblem") : t("ui.orderDetail.detail.reportProblem")}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {/* Only once it's genuinely gone — an expired offer the florist can still
          take shows the Accept button above instead. */}
      {assignment.status === "expired" && !acceptable && <div className="badge badge-neutral">{t("ui.orderDetail.detail.noLongerAvailable")}</div>}
      {assignment.status === "reassigned" && <div className="badge badge-neutral">{t("ui.orderDetail.detail.noLongerAvailable")}</div>}
      {assignment.status === "released" && <div className="badge badge-neutral">{t("ui.orderDetail.detail.gaveBack")}</div>}
      {assignment.status === "declined" && !canReAccept && <div className="badge badge-neutral">{t("ui.orderDetail.detail.declined")}</div>}

      {celebration && <CelebrationModal earned={celebration} onClose={() => setCelebration(null)} />}
    </main>
  );
}
