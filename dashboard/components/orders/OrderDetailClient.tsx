"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Order, OrderLineItem, OrderAssignment, OrderEvent, Florist, Payout, DeliveryEvent, TrustTier, OrderIssue, IssueMessage, OrderApproval, PhotoVerification } from "@/lib/types";
import { ORDER_STATUS_LABEL, type OrderStatus } from "@/lib/orderStatus";
import { stageOf, STAGES, type StageId, type MoveDirection } from "@/lib/orderStages";
import Button from "@/components/ui/Button";
import Badge, { orderStatusBadge } from "@/components/ui/Badge";
import SlaDot from "@/components/ui/SlaDot";
import type { CandidateEngagement } from "@/lib/candidateEngagement";
import ReachoutPanel from "@/components/orders/ReachoutPanel";
import StageStepper from "@/components/orders/StageStepper";
import ApprovalPanel from "@/components/orders/ApprovalPanel";
import HeldPayoutCard from "@/components/orders/HeldPayoutCard";
import ShopifyConflictResolve from "@/components/orders/ShopifyConflictResolve";
import ChangeStageMenu from "@/components/orders/ChangeStageMenu";
import FloristPicker from "@/components/orders/FloristPicker";
import FindFloristsPanel from "@/components/orders/FindFloristsPanel";
import OrderIssues from "@/components/orders/OrderIssues";
import { findAcceptedAssignment, deliverySeverity, deriveCity, deriveCountry, orderAgeLabel, dueInLabel } from "@/components/orders/orderDerive";
import { primaryChip, toneBadgeClass, type OrderVisualInput } from "@/lib/orderVisual";
import { formatDateTime, formatMoney, formatRelative } from "@/components/orders/format";
import { tierBadgeCls, payoutStatusBadgeCls, verdictBadgeCls } from "@/components/orders/badges";
import { eventLabel } from "@/components/orders/orderEvents";
import { legLabel } from "@/components/florist/floristOps";
import { haversineKm } from "@/lib/geo";
import { CONFLICT_EVENT, hasUnresolvedConflict } from "@/lib/shopifyConflict";
import { IconShoppingCart } from "@/components/icons";
import OrderCommunications from "@/components/communications/OrderCommunications";
import type { Communication } from "@/components/communications/types";
import IngredientList, { parseIngredients } from "@/components/florist/IngredientList";

/** Compact one-line peek for a bouquet's recipe, shown next to the collapsed
 *  "Recipe" summary — first ingredient plus a "+N more" count, never the
 *  full breakdown (that's what expanding is for). */
function recipePreview(spec: string | null): string | null {
  const lines = parseIngredients(spec);
  if (lines.length === 0) return null;
  return lines.length > 1 ? `${lines[0]} +${lines.length - 1} more` : lines[0];
}

/** A reference card that collapses so secondary detail sits below the fold. */
function CollapseCard({ id, title, peek, open = false, children }: { id?: string; title: string; peek?: string; open?: boolean; children: React.ReactNode }) {
  return (
    <details id={id} className="card card-collapse" open={open} style={id ? { scrollMarginTop: 16 } : undefined}>
      <summary>
        {title}
        {peek ? <span className="peek">· {peek}</span> : null}
        <span className="chev" aria-hidden="true">›</span>
      </summary>
      <div className="collapse-body">{children}</div>
    </details>
  );
}

// Shopify tags arrive as one comma-separated string — split for individual badges.
// Date tags are intentionally hidden from the top scan: flower delivery is near-term,
// and the dedicated Due in counter is the only prominent delivery-time signal there.
function splitTags(tags: string | null): string[] {
  const dateTag = /\b\d{1,2}\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\b/i;
  return tags ? tags.split(",").map((t) => t.trim()).filter((t) => t && !dateTag.test(t)) : [];
}

function formatAddress(addr: Record<string, unknown> | null): string {
  if (!addr) return "—";
  const line1 = typeof addr.line1 === "string" ? addr.line1 : null;
  const line2 = typeof addr.line2 === "string" ? addr.line2 : null;
  const city = typeof addr.city === "string" ? addr.city : null;
  const postal = typeof addr.postal === "string" ? addr.postal : null;
  const region = typeof addr.region === "string" ? addr.region : null;
  const country = typeof addr.country === "string" ? addr.country : null;
  const cityPostal = [city, postal].filter(Boolean).join(" ");
  const parts = [line1, line2, cityPostal, region, country].map((p) => p?.trim()).filter((p): p is string => !!p);
  return parts.length ? parts.join(", ") : "—";
}

function LineItemThumb({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return (
      <div className="thumb" style={{ width: 56, height: 56, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <IconShoppingCart style={{ width: 22, height: 22, color: "var(--ink-faint)" }} />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" width={56} height={56} style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 7, background: "var(--surface-2)" }} onError={() => setFailed(true)} />
  );
}

function proofLabel(type: string): string {
  if (type === "delivered_photo") return "Delivered";
  if (type === "ready_photo") return "Ready";
  return type;
}

function DeliveryProofPhoto({ event, onEnlarge }: { event: DeliveryEvent; onEnlarge: () => void }) {
  const [failed, setFailed] = useState(false);
  const label = proofLabel(event.type);
  const src = event.photo_key ? `/api/orders/photo?key=${encodeURIComponent(event.photo_key)}` : null;
  if (!src || failed) {
    return (
      <div className="spec">
        <div style={{ fontWeight: 600, color: "var(--ink)" }}>{label} photo</div>
        <div style={{ marginTop: 4, color: "var(--crit)", fontSize: ".82rem" }}>Couldn&apos;t load photo (key: {event.photo_key ?? "—"})</div>
      </div>
    );
  }
  return (
    <div>
      <button type="button" onClick={onEnlarge} aria-label={`Enlarge ${label.toLowerCase()} photo`} className="block cursor-zoom-in border-0 bg-transparent p-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={`${label} delivery proof`} className="h-[200px] w-full max-w-[320px] rounded border border-line object-cover" onError={() => setFailed(true)} />
      </button>
      <div style={{ marginTop: 6, fontSize: ".78rem", color: "var(--ink-faint)" }}>{label} · {formatDateTime(event.created_at)}</div>
      {event.note && <div style={{ marginTop: 4, fontSize: ".85rem" }}>{event.note}</div>}
    </div>
  );
}

// AI photo-verify judgments for this order's assignment(s) — read-only staff
// QA surface. `verdict` no longer gates the payout (see lib/payoutHold.ts,
// deliberately untouched here); this panel exists purely so staff can see
// what the check concluded and decide by hand whether a payout needs a
// second look. Newest run first (page.tsx already orders the fetch that way).
function PhotoVerificationPanel({ verifications }: { verifications: PhotoVerification[] }) {
  if (verifications.length === 0) return null;
  return (
    <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 12, display: "grid", gap: 12 }}>
      <div style={{ fontSize: ".76rem", color: "var(--ink-faint)" }}>
        🤖 AI photo check — the model&apos;s read on the photo, for QA only. Does not block payout.
      </div>
      {verifications.map((v) => {
        const hasShadow = v.openrouter_gemini_ok != null || v.openrouter_qwen_ok != null;
        return (
          <div key={v.id} style={{ display: "grid", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className={`badge ${verdictBadgeCls(v.verdict)}`}>{v.verdict}</span>
              <span style={{ fontSize: ".82rem", color: "var(--ink-soft)" }}>
                {v.confidence != null ? `${Math.round(v.confidence * 100)}% confidence` : "confidence —"}
              </span>
              <span style={{ fontSize: ".78rem", color: "var(--ink-faint)" }}>{formatRelative(v.created_at)}</span>
            </div>
            {v.reasoning && <p style={{ margin: 0, fontSize: ".85rem", color: "var(--ink)" }}>{v.reasoning}</p>}
            {(v.providers.length > 0 || hasShadow) && (
              <details className="recipe-details">
                <summary>Provider detail{v.providers.length ? ` (${v.providers.length})` : ""}</summary>
                <div style={{ marginTop: 6, display: "grid", gap: 8 }}>
                  {v.providers.map((p, i) => (
                    <div key={i} className="spec">
                      <div style={{ fontWeight: 600, color: "var(--ink)", textTransform: "capitalize" }}>
                        {p.provider}
                        {!p.ok ? (
                          <span style={{ color: "var(--crit)" }}> · errored</span>
                        ) : (
                          <span> · {p.matched ? "matched" : "not matched"} · {Math.round(p.confidence * 100)}% confidence</span>
                        )}
                      </div>
                      {p.notes && <div style={{ marginTop: 4 }}>{p.notes}</div>}
                      {p.itemsFound.length > 0 && (
                        <div style={{ marginTop: 4 }}><b style={{ color: "var(--ink)" }}>Found:</b> {p.itemsFound.join(", ")}</div>
                      )}
                      {p.itemsMissing.length > 0 && (
                        <div style={{ marginTop: 4, color: "var(--warn)" }}><b>Missing:</b> {p.itemsMissing.join(", ")}</div>
                      )}
                      {p.error && <div style={{ marginTop: 4, color: "var(--crit)" }}>{p.error}</div>}
                    </div>
                  ))}
                  {hasShadow && (
                    <details className="recipe-details">
                      <summary>Shadow-mode (OpenRouter) — evaluation only, not part of the verdict above</summary>
                      <pre className="spec" style={{ marginTop: 6, whiteSpace: "pre-wrap", fontFamily: "var(--mono)", fontSize: ".72rem" }}>
                        {JSON.stringify(
                          {
                            gemini: {
                              score: v.openrouter_gemini_score, matched: v.openrouter_gemini_matched,
                              confidence: v.openrouter_gemini_confidence, notes: v.openrouter_gemini_notes,
                              model: v.openrouter_gemini_model, ok: v.openrouter_gemini_ok, error: v.openrouter_gemini_error,
                            },
                            qwen: {
                              score: v.openrouter_qwen_score, matched: v.openrouter_qwen_matched,
                              confidence: v.openrouter_qwen_confidence, notes: v.openrouter_qwen_notes,
                              model: v.openrouter_qwen_model, ok: v.openrouter_qwen_ok, error: v.openrouter_qwen_error,
                            },
                          },
                          null,
                          2
                        )}
                      </pre>
                    </details>
                  )}
                </div>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PhotoLightbox({ src, alt, caption, onClose }: { src: string; alt: string; caption: string; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/60 p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label={alt}>
      <div className="flex max-h-[90vh] max-w-[90vw] flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} className="max-h-[80vh] max-w-full rounded object-contain" />
        <div className="flex items-center gap-3 text-sm text-white">
          <span>{caption}</span>
          <button type="button" onClick={onClose} className="rounded-md bg-white/10 px-2.5 py-1 text-xs font-medium text-white hover:bg-white/20">Close</button>
        </div>
      </div>
    </div>
  );
}

// The order's status can be `escalated`/`cancelled` (overlays that lose the
// underlying stage) — derive a display stage from the assignments so the stepper
// still shows where the order actually is.
function deriveStage(order: Order, assignments: OrderAssignment[]): { stage: StageId; escalated: boolean; cancelled: boolean } {
  const s = stageOf(order.status);
  if (s !== "escalated" && s !== "cancelled") return { stage: s, escalated: false, cancelled: false };
  const hasAccepted = assignments.some((a) => a.status === "accepted" || a.status === "delivered");
  const hasOffer = assignments.some((a) => ["sent", "opened", "queued", "candidate"].includes(a.status));
  const stage: StageId = hasAccepted ? "fulfilment" : hasOffer ? "outreach" : "matched";
  return { stage, escalated: s === "escalated", cancelled: s === "cancelled" };
}

type PendingMove = { to: OrderStatus; message: string; serverConfirm: boolean } | null;

export default function OrderDetailClient({
  order, items, assignments, events, florists, testMode, workflowMode, payouts, deliveryEvents, photoVerifications = [], trustTiers, issues, issueMessages, approvals = [], cityName = null, countryName = null, communications = [], canManagePayouts, isAdmin, shopifyOrderUrl = null, engagement,
}: {
  order: Order; items: OrderLineItem[]; assignments: OrderAssignment[]; events: OrderEvent[]; florists: Florist[];
  /** Per-assignment engagement trail for the candidate list, resolved on the
   *  server (see lib/candidateEngagement.ts). Keyed by assignment id. */
  engagement?: Record<string, CandidateEngagement>;
  testMode: boolean; workflowMode: string; payouts: Payout[]; deliveryEvents: DeliveryEvent[];
  /** AI photo-verify judgments for this order's assignment(s) — read-only QA
   *  surface, see PhotoVerificationPanel. Does not gate payout. */
  photoVerifications?: PhotoVerification[];
  trustTiers: TrustTier[];
  issues: OrderIssue[]; issueMessages: IssueMessage[]; approvals?: OrderApproval[];
  cityName?: string | null; countryName?: string | null; communications?: Communication[];
  /** Whether the signed-in staff member's role (finance/admin) may act on held
   * payouts — hides the approve/reject/release-without-photo controls otherwise. */
  canManagePayouts: boolean;
  /** Admin-only: shows the Delete/Restore order control. */
  isAdmin: boolean;
  shopifyOrderUrl?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lightboxProof, setLightboxProof] = useState<DeliveryEvent | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingMove>(null);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [releaseReason, setReleaseReason] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [payoutEditOpen, setPayoutEditOpen] = useState(false);
  const [payoutValue, setPayoutValue] = useState("");

  async function deleteOrRestore(restore: boolean) {
    setDeleteBusy(true); setActionError(null);
    try {
      const res = await fetch("/api/orders/delete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: order.id, restore }),
      });
      if (!res.ok) setActionError((await res.json().catch(() => ({}))).error ?? `Failed to ${restore ? "restore" : "delete"} the order.`);
      else { setConfirmingDelete(false); router.refresh(); }
    } catch { setActionError("Network error — please retry."); }
    finally { setDeleteBusy(false); }
  }

  // Generic {orderId} POST (reassign / resolve-escalation / rematch).
  async function runAction(key: string, url: string) {
    setBusy(key); setActionError(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId: order.id }) });
      if (!res.ok) setActionError((await res.json().catch(() => ({}))).error ?? "Action failed.");
      else router.refresh();
    } catch { setActionError("Network error — please retry."); }
    finally { setBusy(null); }
  }

  // Admin: reconcile THIS order — re-pull its Shopify tags and re-evaluate
  // matching (the per-order counterpart to the orders-list "Reconcile now").
  const [reconcileBusy, setReconcileBusy] = useState(false);
  const [reconcileNote, setReconcileNote] = useState<string | null>(null);
  async function reconcileThisOrder() {
    if (reconcileBusy) return;
    setReconcileBusy(true); setActionError(null); setReconcileNote(null);
    try {
      const res = await fetch("/api/orders/reconcile", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: order.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setActionError(j.error ?? "Reconcile failed."); return; }
      if (!j.found) {
        setActionError(j.reason === "shopify-error" ? "Couldn't reach Shopify to re-pull tags." : j.reason === "not-found" ? "Order not found." : "Shopify isn't configured on the worker.");
      } else if (j.result === "matched") { setReconcileNote("Re-matched — candidates created."); router.refresh(); }
      else if (j.result === "updated") { setReconcileNote("Tags refreshed (no match needed)."); router.refresh(); }
      else setReconcileNote("Already up to date — nothing changed.");
    } catch { setActionError("Network error — please retry."); }
    finally { setReconcileBusy(false); }
  }

  // Approve / reject a held payout leg (the held-30% gate).
  async function payoutAction(payoutId: string, action: "approve" | "reject") {
    setBusy(payoutId + action); setActionError(null);
    try {
      const res = await fetch(`/api/orders/payout/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "reject" ? { payoutId, reason: "proof rejected" } : { payoutId }),
      });
      if (!res.ok) setActionError((await res.json().catch(() => ({}))).error ?? "Payout action failed.");
      else router.refresh();
    } catch { setActionError("Network error — please retry."); }
    finally { setBusy(null); }
  }

  // Staff override: release the 30% when the florist delivered but never uploaded
  // a proof photo (CX confirmed delivery out-of-band). Reason is mandatory.
  async function releaseWithoutPhoto(assignmentId: string) {
    const reason = releaseReason.trim();
    if (!reason) { setActionError("Add a reason before releasing without a photo."); return; }
    setBusy("release-no-photo"); setActionError(null);
    try {
      const res = await fetch("/api/orders/payout/release-without-photo", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignmentId, reason }),
      });
      if (!res.ok) setActionError((await res.json().catch(() => ({}))).error ?? "Couldn't release the payout.");
      else { setReleaseOpen(false); setReleaseReason(""); router.refresh(); }
    } catch { setActionError("Network error — please retry."); }
    finally { setBusy(null); }
  }

  // Manual staff override of a locked-in payout amount (special-case pricing).
  async function overridePayout(assignmentId: string) {
    const parsed = Number(payoutValue);
    if (!Number.isFinite(parsed) || parsed < 0) { setActionError("Enter a valid payout amount."); return; }
    setBusy("payout-override"); setActionError(null);
    try {
      const res = await fetch("/api/orders/payout/override", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignmentId, payoutPrice: parsed }),
      });
      if (!res.ok) setActionError((await res.json().catch(() => ({}))).error ?? "Couldn't update the payout amount.");
      else { setPayoutEditOpen(false); router.refresh(); }
    } catch { setActionError("Network error — please retry."); }
    finally { setBusy(null); }
  }

  async function executeMove(to: OrderStatus, confirm: boolean) {
    setBusy("status"); setActionError(null);
    try {
      const res = await fetch("/api/orders/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId: order.id, to, confirm }) });
      const body = await res.json().catch(() => ({}));
      if (res.ok) { setPendingMove(null); router.refresh(); }
      else if (body.needsConfirm) setPendingMove({ to, message: body.warning ?? "This move needs confirmation.", serverConfirm: true });
      else setActionError(body.error ?? "Couldn't change the stage.");
    } catch { setActionError("Network error — please retry."); }
    finally { setBusy(null); }
  }

  // Forward moves apply immediately; back/flag moves confirm first (and the
  // server may still raise a payout warning, handled via pendingMove).
  function changeStage(to: OrderStatus, dir: MoveDirection) {
    if (dir === "forward") { void executeMove(to, false); return; }
    setPendingMove({ to, message: `Move this order to “${ORDER_STATUS_LABEL[to]}”? This is a ${dir === "back" ? "backward" : "flag"} move.`, serverConfirm: false });
  }

  const floristById = new Map(florists.map((f) => [f.id, f]));
  const tierByCode = new Map(trustTiers.map((t) => [t.code, t]));
  // "The assignment" means accepted — a candidate merely sent/opened an offer
  // is a reach-out in progress, shown in ReachoutPanel, not here. See
  // findAcceptedAssignment.
  const leading = findAcceptedAssignment(assignments);
  const leadingFlorist = leading ? floristById.get(leading.florist_id) ?? null : null;
  const leadingTier = leadingFlorist?.trust_tier ? tierByCode.get(leadingFlorist.trust_tier) ?? null : null;
  const assignedIds = new Set(assignments.map((a) => a.florist_id));
  const hasCandidates = assignments.some((a) => a.status === "candidate" || a.status === "queued");
  // "Release without photo": the florist delivered but no proof arrived, so no
  // delivery-leg payout row exists to approve. Offer the override only then.
  const deliverableAssignment = assignments.find((a) => a.status === "accepted" || a.status === "delivered") ?? null;
  const hasDeliveryPayout = payouts.some((p) => p.leg === "delivery");
  const canReleaseWithoutPhoto = !!deliverableAssignment && !hasDeliveryPayout;

  // Shopify conflict resolve affordance: shown only while unresolved AND our
  // status isn't already terminal (see lib/shopifyConflict.ts).
  const unresolvedConflict = order.status !== "closed" && order.status !== "cancelled" && hasUnresolvedConflict(events);
  const conflictEvent = events.find((e) => e.type === CONFLICT_EVENT);

  const allLineTotalsKnown = items.length > 0 && items.every((it) => it.line_total != null);
  const itemsSum = allLineTotalsKnown ? items.reduce((sum, it) => sum + (it.line_total ?? 0), 0) : null;
  // order.total includes shipping (tax/discounts already netted in by Shopify) —
  // compare against items + shipping, not items alone, or every order with a
  // delivery fee falsely flags as a mismatch.
  const itemsPlusShipping = itemsSum != null ? itemsSum + (order.shipping_total ?? 0) : null;
  const totalMismatch = itemsPlusShipping != null && order.total != null && Math.abs(itemsPlusShipping - order.total) > 0.01;

  const deliveredProof = deliveryEvents.find((e) => e.type === "delivered_photo" && !!e.photo_key) ?? null;
  const readyProof = deliveryEvents.find((e) => e.type === "ready_photo" && !!e.photo_key) ?? null;
  const photoProofs = [deliveredProof, readyProof].filter((p): p is DeliveryEvent => p !== null);

  const display = deriveStage(order, assignments);
  const openIssueCount = issues.filter((i) => i.status === "open").length;

  // Once a florist has accepted (and the order has moved past it), the
  // reach-out trail is history, not work-in-progress — collapse it by
  // default so it stops competing with what's actually actionable. Before
  // acceptance, reach-outs ARE the work, so it stays open.
  const REACHOUT_COLLAPSED_STATUSES: OrderStatus[] = ["accepted", "in_production", "ready", "out_for_delivery", "delivered", "paid", "closed"];
  const reachoutsOpenByDefault = !REACHOUT_COLLAPSED_STATUSES.includes(order.status);

  // Communications card: peek shows "N sent · M failed"; defaults collapsed
  // unless a failed send needs attention.
  const commsSentCount = communications.filter((c) => c.status === "sent").length;
  const commsFailedCount = communications.filter((c) => c.status === "failed").length;
  const commsPeek = communications.length
    ? `${commsSentCount} sent${commsFailedCount ? ` · ${commsFailedCount} failed` : ""}`
    : undefined;
  const stageLabel = STAGES.find((s) => s.id === display.stage)?.label ?? "—";
  const anyBusy = busy !== null;

  // Distance from the current florist to the delivery address (null-guarded —
  // hidden until a florist with coords is assigned).
  const distanceKm = leadingFlorist
    ? haversineKm(leadingFlorist.lat, leadingFlorist.lng, order.delivery_lat, order.delivery_lng)
    : null;
  // Prefer the DB-joined city/country (from the order's city_id); fall back to
  // the delivery_area-derived helpers (same ones the Orders list uses) for
  // orders that never resolved a city_id.
  const placeLine = [countryName || deriveCountry(order), cityName || deriveCity(order)]
    .filter((p) => p && p !== "—")
    .join(" · ") || "—";
  // Delivery urgency colors both the Status-derived top signal and the coarse
  // Due in counter. We deliberately keep the top strip to one countdown-style
  // delivery signal, not a date/time plus a duplicate timer.
  const deadlineSeverity = deliverySeverity(order.status, order.delivery_at);

  // Control-room primary status: the same attention/priority logic that
  // colors the Orders list rows (lib/orderVisual.ts), so a staffer scanning
  // both screens reads the same signal the same way. Distinct from the plain
  // ORDER_STATUS_LABEL badge in the command bar above — this one surfaces
  // "stuck"/SLA-breaching/payout-held conditions the raw status hides.
  const heldPayouts = payouts.filter((p) => p.status === "held");
  const failedPayouts = payouts.filter((p) => p.status === "failed");
  const visualInput: OrderVisualInput = {
    status: order.status,
    delivery_at: order.delivery_at,
    assignments: assignments.map((a) => ({ status: a.status })),
    candidateCount: assignments.length,
    // orderVisual treats any held/failed payout as money needing review, matching
    // the Orders list's server-fed `moneyHeld` flag.
    moneyHeld: heldPayouts.length > 0 || failedPayouts.length > 0,
  };
  const primary = primaryChip(visualInput);

  // The contextual operations for the current stage.
  function stageOps() {
    switch (display.stage) {
      case "created":
      case "matched":
        return (
          <>
            <FindFloristsPanel orderId={order.id} label="Find florists" />
            {hasCandidates && <Button variant="solid" disabled={anyBusy} onClick={() => changeStage("reaching_out", "forward")}>Start reach-out</Button>}
          </>
        );
      case "outreach":
        return (
          <>
            <Button variant="default" disabled={anyBusy} onClick={() => runAction("reassign", "/api/orders/reassign")}>Reassign (next)</Button>
            <FindFloristsPanel orderId={order.id} label="Find more" />
            <Button variant="ghost" disabled={anyBusy} onClick={() => changeStage("matched", "back")}>Back to matched</Button>
          </>
        );
      case "fulfilment":
        return (
          <>
            {order.status === "accepted" && <Button variant="solid" disabled={anyBusy} onClick={() => changeStage("in_production", "forward")}>Mark in production</Button>}
            {order.status === "in_production" && <Button variant="solid" disabled={anyBusy} onClick={() => changeStage("ready", "forward")}>Mark ready</Button>}
            {order.status === "ready" && <Button variant="solid" disabled={anyBusy} onClick={() => changeStage("out_for_delivery", "forward")}>Mark out for delivery</Button>}
          </>
        );
      case "delivery":
        return <Button variant="solid" disabled={anyBusy} onClick={() => changeStage("delivered", "forward")}>Mark delivered</Button>;
      case "delivered":
        return (
          <>
            {order.status === "delivered" && <Button variant="solid" disabled={anyBusy} onClick={() => changeStage("paid", "forward")}>Release payout</Button>}
            {order.status === "paid" && <Button variant="solid" disabled={anyBusy} onClick={() => changeStage("closed", "forward")}>Close order</Button>}
          </>
        );
    }
  }

  const canAddFlorist = ["created", "matched", "outreach"].includes(display.stage);

  return (
    <main className="ds page" style={{ display: "grid", gap: 18 }}>
      <Link href="/orders" className="eyebrow">← Orders</Link>

      {order.deleted_at && (
        <div className="card" style={{ borderColor: "var(--crit)", background: "color-mix(in srgb, var(--crit) 10%, transparent)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ color: "var(--crit)", fontSize: ".85rem", fontWeight: 600 }}>🗑 Deleted {formatDateTime(order.deleted_at)} — hidden from the orders list.</span>
          {isAdmin && <Button variant="default" disabled={deleteBusy} onClick={() => deleteOrRestore(true)}>Restore</Button>}
        </div>
      )}

      {/* Command bar: identity + journey on one row */}
      <div className="card cmdbar">
        <div className="cmd-id" style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
          <div style={{ display: "grid", gap: 4 }}>
            <h1 style={{ margin: 0, fontSize: "1.4rem", fontFamily: "var(--mono)" }}>{order.order_name ?? order.id.slice(0, 8)}</h1>
            {shopifyOrderUrl && (
              <a href={shopifyOrderUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: ".8rem", color: "var(--ink-faint)" }}>
                View in Shopify ↗
              </a>
            )}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", maxWidth: 260 }}>
            <Badge info={orderStatusBadge(order.status)} />
            {splitTags(order.tags).map((t) => <span key={t} className="badge badge-neutral">{t}</span>)}
          </div>
        </div>
        <div className="cmd-step">
          <StageStepper current={display.stage} escalated={display.escalated} cancelled={display.cancelled} issueCount={openIssueCount} />
        </div>
        {isAdmin && !order.deleted_at && (
          // Stacked in two rows (rather than side by side) so both actions
          // still fit once the command bar is squeezed narrow.
          <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
            <Button variant="ghost" disabled={reconcileBusy} onClick={reconcileThisOrder}
              title="Re-pull this order's tags from Shopify and re-evaluate matching">
              {reconcileBusy ? "Reconciling…" : "↻ Re-pull from Shopify"}
            </Button>
            {confirmingDelete ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: ".8rem", color: "var(--ink-soft)" }}>Delete this order?</span>
                <Button variant="warn" disabled={deleteBusy} onClick={() => deleteOrRestore(false)}>Confirm delete</Button>
                <Button variant="ghost" disabled={deleteBusy} onClick={() => setConfirmingDelete(false)}>Cancel</Button>
              </div>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmingDelete(true)}>Delete order</Button>
            )}
          </div>
        )}
      </div>
      {reconcileNote && (
        <p role="status" style={{ margin: "6px 0 0", fontSize: ".82rem", color: "var(--ink-soft)" }}>{reconcileNote}</p>
      )}

      {/* Control room: the glance facts a staffer needs in seconds to decide
          "what needs action and who can fulfill it" — attention-aware status,
          florist availability/distance, destination, a single deadline
          signal, and money/other-attention only when they're actually
          actionable. Recipient/buyer details are deliberately NOT here (see
          "Recipient & delivery" below) — they don't drive a florist-matching
          decision. Fits the shared 6-up `.vitals` layout with no override. */}
      <div className="vitals">
        <div className="vital">
          <div className="vital-l">● Status</div>
          <div className="vital-v">
            <span className={`badge ${toneBadgeClass(primary.tone)}`}>{primary.label}</span>
          </div>
        </div>
        <div className="vital">
          <div className="vital-l">✿ Florist</div>
          <div className="vital-v">
            {leadingFlorist ? (
              <>
                <Link href={`/florists/${leadingFlorist.id}`} className="link">{leadingFlorist.name}</Link>
                {leadingTier ? <small> · {leadingTier.label}</small> : leadingFlorist.trust_tier ? <small> · T{leadingFlorist.trust_tier}</small> : null}
                {distanceKm != null ? <small> · {distanceKm} km</small> : null}
              </>
            ) : ["received", "matched"].includes(order.status) ? "Matching…" : "—"}
          </div>
        </div>
        <div className="vital">
          <div className="vital-l">📍 Destination</div>
          <div className="vital-v" title={formatAddress(order.delivery_address)}>
            {placeLine}
          </div>
        </div>
        <div className="vital">
          <div className="vital-l">⏱ Due in</div>
          <div className="vital-v">
            <span style={{ color: deadlineSeverity === "crit" ? "var(--crit)" : deadlineSeverity === "warn" ? "var(--warn)" : "var(--ink)" }}>
              {dueInLabel(order.status, order.delivery_at)}
            </span>
          </div>
        </div>
        <div className="vital">
          <div className="vital-l">🕓 In system</div>
          <div className="vital-v">{orderAgeLabel(order.created_at)}</div>
        </div>
        <div className="vital">
          <div className="vital-l" title="What we're willing to pay the florist for this order — not what the buyer paid, and not necessarily paid out yet">💳 Payout offer</div>
          <div className="vital-v">
            {leading ? (
              <>
                {formatMoney(leading.payout_price, order.currency)}
                {leading.payout_percent == null && leading.payout_price != null && <small> · manual</small>}
                {failedPayouts.length > 0 ? (
                  <small style={{ color: "var(--crit)" }}> · failed</small>
                ) : heldPayouts.length > 0 ? (
                  <small style={{ color: "var(--warn)" }}> · held</small>
                ) : null}
              </>
            ) : "—"}
          </div>
        </div>
      </div>

      {/* Step-mode (semi): every proposed transition awaiting a human, front and centre */}
      {approvals.filter((a) => a.status === "pending").map((a) => (
        <ApprovalPanel
          key={a.id}
          approval={a}
          floristName={a.assignment_id ? floristById.get(assignments.find((x) => x.id === a.assignment_id)?.florist_id ?? "")?.name ?? null : null}
          floristNames={Object.fromEntries(florists.map((f) => [f.id, f.name]))}
        />
      ))}

      {/* A held payout leg, front and centre next to the approvals — the one
       * thing on this order that is holding the florist's money.
       *
       * The card and the finance-gated approve/reject routes behind it have
       * existed since the unified CX desk; what did NOT exist was anywhere
       * that mounted it. The desk lived on /cx, which was removed 2026-08-10,
       * and nothing took the card with it — so a `tier-hold` / `provisional-shop`
       * leg sat in `payouts.status='held'` with no way to release it short of
       * calling the API by hand (lifecycle.ts, `pay-accept-no-release-surface`
       * and `pay-deliver-no-release-surface`). The Operator panel's "Approve the
       * payment" row links here, so it needed a home again.
       *
       * Gated on `canManagePayouts` (finance/admin), exactly like every other
       * payout control on this page — the API enforces the same, this only
       * stops showing a button that would 403. */}
      {canManagePayouts && heldPayouts.length > 0 && (
        <div id="payout" style={{ scrollMarginTop: 16, display: "grid", gap: 10 }}>
          {heldPayouts.map((p) => {
            const asg = assignments.find((a) => a.id === p.assignment_id);
            return (
              <HeldPayoutCard
                key={p.id}
                payoutId={p.id}
                leg={p.leg}
                amount={p.amount ?? 0}
                currency={p.currency ?? order.currency ?? "EUR"}
                floristName={asg ? floristById.get(asg.florist_id)?.name ?? null : null}
                orderId={order.id}
                orderName={order.order_name}
              />
            );
          })}
        </div>
      )}

      {unresolvedConflict && (
        <ShopifyConflictResolve
          orderId={order.id}
          conflictEvent={conflictEvent}
          floristName={leadingFlorist?.name ?? null}
          assignmentStatus={leading?.status === "accepted" || leading?.status === "delivered" ? leading.status : null}
          hasDeliveryPayout={hasDeliveryPayout}
        />
      )}

      {/* Contextual "Now" panel */}
      <div className="card">
        <div className="mini-h" style={{ marginBottom: 10, display: "flex", justifyContent: "space-between" }}>
          <span>Now · {stageLabel}</span>
          <span>{testMode ? "TEST MODE" : "LIVE"} · {workflowMode}</span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          {stageOps()}
          {order.status === "escalated" && (
            <Button variant="solid" disabled={anyBusy} onClick={() => runAction("resolve", "/api/orders/resolve-escalation")}>Resolve escalation</Button>
          )}
          <ChangeStageMenu current={order.status} busy={anyBusy} onSelect={changeStage} />
        </div>
        {canAddFlorist && (
          <div style={{ marginTop: 12 }}>
            <FloristPicker orderId={order.id} assignedIds={assignedIds} />
          </div>
        )}
        {pendingMove && (
          <div style={{ marginTop: 12, border: "1px solid var(--warn)", background: "color-mix(in srgb, var(--warn) 8%, transparent)", borderRadius: 8, padding: 12 }}>
            <p style={{ fontSize: ".85rem", color: "var(--ink)" }}>{pendingMove.message}</p>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <Button variant="warn" disabled={anyBusy} onClick={() => void executeMove(pendingMove.to, pendingMove.serverConfirm)}>Confirm</Button>
              <Button variant="ghost" disabled={anyBusy} onClick={() => setPendingMove(null)}>Cancel</Button>
            </div>
          </div>
        )}
        {actionError && <div style={{ color: "var(--crit)", fontSize: ".82rem", marginTop: 10 }}>{actionError}</div>}
      </div>

      <div id="issues" style={{ scrollMarginTop: 16 }}>
        <OrderIssues issues={issues} messages={issueMessages} />
      </div>

      <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-2">
        {/* LEFT column */}
        <div style={{ display: "grid", gap: 18, alignContent: "start" }}>
          <CollapseCard title="Order & buyer" peek={[order.buyer_name, order.occasion].filter(Boolean).join(" · ") || undefined}>
            <dl className="kv">
              <dt>Buyer</dt><dd>{order.buyer_name ?? "—"}</dd>
              <dt>Email</dt><dd>{order.buyer_email ?? "—"}</dd>
              <dt>Phone</dt><dd>{order.buyer_phone ?? "—"}</dd>
              <dt>Occasion</dt><dd>{order.occasion ?? "—"}</dd>
              <dt>Substitution</dt><dd>{order.substitution_policy ?? "—"}</dd>
              <dt>Shopify ID</dt><dd style={{ fontFamily: "var(--mono)" }}>{order.shopify_order_id ?? "—"}</dd>
            </dl>
            <p style={{ marginTop: 10, fontSize: ".85rem" }}>
              <b style={{ color: "var(--ink)" }}>Card:</b> <span style={{ color: "var(--ink-soft)", whiteSpace: "pre-line" }}>{order.greeting ?? "—"}</span>
            </p>
            <p style={{ marginTop: 6, fontSize: ".85rem" }}>
              <b style={{ color: "var(--ink)" }}>Notes:</b> <span style={{ color: "var(--ink-soft)" }}>{order.notes ?? "—"}</span>
            </p>
          </CollapseCard>

          <CollapseCard title="Recipient & delivery" peek={order.delivery_area ?? undefined}>
            <dl className="kv">
              <dt>Recipient</dt><dd>{order.recipient_name ?? "—"}</dd>
              <dt>Phone</dt><dd>{order.recipient_phone ?? "—"}</dd>
              <dt>Address</dt><dd>{formatAddress(order.delivery_address)}</dd>
              <dt>Area</dt><dd>{order.delivery_area ?? "—"}</dd>
              <dt>Deliver</dt>
              <dd>{formatDateTime(order.delivery_at)}{order.delivery_window ? ` (${order.delivery_window})` : ""}</dd>
            </dl>
          </CollapseCard>

          {/* Expanded by default — product/line-item detail (title, variant,
              qty, sku, components, addons, prices) is exactly what a staffer
              scanning the order needs to see immediately. Only the bouquet
              recipe/spec breakdown below is collapsed per line item — see the
              nested <details> below. `variant_text` is deliberately never
              rendered: it's Shopify storefront upsell copy ("Excellent!
              You're sending…"), not operational detail — see lib/lifecycle.ts. */}
          <CollapseCard
            title="Line items"
            open
            peek={
              items.length
                ? `${items.length} item${items.length === 1 ? "" : "s"}${itemsSum != null ? ` · ${formatMoney(itemsSum, order.currency)}` : ""}`
                : undefined
            }
          >
            {items.length === 0 && <p style={{ color: "var(--ink-faint)", fontSize: ".9rem" }}>No line items.</p>}
            {items.map((it) => (
              <div key={it.id}>
                <div className="line-item">
                  <LineItemThumb url={it.image_url} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      {it.title ?? "—"}{it.variant ? ` — ${it.variant}` : ""}{" "}
                      <span style={{ color: "var(--ink-faint)", fontWeight: 400 }}>×{it.quantity}</span>
                    </div>
                    {(it.sku || it.barcode) && (
                      <div style={{ fontSize: ".72rem", color: "var(--ink-faint)", fontFamily: "var(--mono)" }}>
                        {it.sku ? `SKU ${it.sku}` : null}{it.sku && it.barcode ? " · " : ""}{it.barcode ? `Barcode ${it.barcode}` : null}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: "right", fontSize: ".85rem", flexShrink: 0 }}>
                    <div style={{ color: "var(--ink-soft)" }}>{formatMoney(it.unit_price, order.currency)}</div>
                    <div style={{ fontWeight: 700 }}>{formatMoney(it.line_total, order.currency)}</div>
                  </div>
                </div>
                {it.bouquet_spec && (
                  <details className="recipe-details" style={{ marginLeft: 66, marginBottom: 9 }}>
                    <summary>
                      Recipe{recipePreview(it.bouquet_spec) ? ` · ${recipePreview(it.bouquet_spec)}` : ""}
                    </summary>
                    <div className="spec" style={{ marginTop: 6 }}>
                      <IngredientList spec={it.bouquet_spec} />
                    </div>
                  </details>
                )}
                {it.components && (
                  <div style={{ marginLeft: 66, marginBottom: 4, fontSize: ".78rem" }}>
                    <span style={{ color: "var(--ink-faint)" }}>Components:</span> {it.components}
                  </div>
                )}
                {it.addons && (
                  <div style={{ marginLeft: 66, marginBottom: 9, fontSize: ".78rem" }}>
                    <span style={{ color: "var(--ink-faint)" }}>Add-ons:</span> {it.addons}
                  </div>
                )}
              </div>
            ))}
            {items.length > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line)", fontSize: ".85rem" }}>
                <span style={{ color: "var(--ink-faint)" }}>Items total</span>
                <span style={{ fontWeight: 700 }}>
                  {itemsSum != null ? formatMoney(itemsSum, order.currency) : "—"}
                  {totalMismatch && (
                    <span
                      style={{ color: "var(--crit)", marginLeft: 8, fontWeight: 600 }}
                      title={`Items + shipping is ${formatMoney(itemsPlusShipping, order.currency)}, but the order total is ${formatMoney(order.total, order.currency)}`}
                    >
                      ⚠ mismatch
                    </span>
                  )}
                </span>
              </div>
            )}
          </CollapseCard>
        </div>

        {/* RIGHT column */}
        <div style={{ display: "grid", gap: 18, alignContent: "start" }}>
          <div className="card">
            <div className="mini-h" style={{ marginBottom: 10 }}>Assignment</div>
            {!leading ? (
              <p style={{ color: "var(--ink-faint)", fontSize: ".9rem" }}>No active assignment.</p>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Link href={`/florists/${leading.florist_id}`} className="link" style={{ fontWeight: 700 }}>
                    {leadingFlorist?.name ?? leading.florist_id.slice(0, 8)}
                  </Link>
                  {leadingFlorist?.trust_tier && (
                    <span className={`badge ${tierBadgeCls(leadingFlorist.trust_tier)}`}>{leadingTier?.label ?? leadingFlorist.trust_tier}</span>
                  )}
                  <span style={{ color: "var(--ink-soft)", fontSize: ".82rem" }}>
                    {leading.offer_kind === "exclusive" ? "Reserved" : leading.offer_kind === "race" ? "First-to-accept" : "—"}
                  </span>
                  {leading.sla_deadline_at && <SlaDot deadlineIso={leading.sla_deadline_at} label={`SLA ${formatDateTime(leading.sla_deadline_at)}`} />}
                </div>
                <dl className="kv" style={{ marginTop: 10 }}>
                  <dt>Assigned</dt><dd>{formatDateTime(leading.assigned_at)}</dd>
                  <dt>Sent</dt><dd>{formatDateTime(leading.sent_at)}</dd>
                  <dt>Accepted</dt><dd>{formatDateTime(leading.accepted_at)}</dd>
                  <dt title="What we're willing to pay the florist for this order — not what the buyer paid, and not necessarily paid out yet">Payout offer</dt>
                  <dd>
                    {!payoutEditOpen ? (
                      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {formatMoney(leading.payout_price, order.currency)}
                        {leading.payout_percent == null && leading.payout_price != null && (
                          <span className="badge" title="Set by hand — no longer tied to the default payout percent">manual</span>
                        )}
                        {canManagePayouts && (
                          <button
                            type="button"
                            className="link"
                            style={{ fontSize: ".78rem" }}
                            onClick={() => { setPayoutValue(leading.payout_price != null ? String(leading.payout_price) : ""); setPayoutEditOpen(true); }}
                          >
                            Edit
                          </button>
                        )}
                      </span>
                    ) : (
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <input
                          type="number" min="0" step="0.01" value={payoutValue}
                          onChange={(e) => setPayoutValue(e.target.value)}
                          style={{ width: 90, padding: "3px 6px", fontSize: ".85rem" }}
                          autoFocus
                        />
                        <Button variant="solid" disabled={busy === "payout-override"} onClick={() => overridePayout(leading.id)}>Save</Button>
                        <Button variant="default" disabled={busy === "payout-override"} onClick={() => setPayoutEditOpen(false)}>Cancel</Button>
                      </span>
                    )}
                  </dd>
                </dl>
              </>
            )}
          </div>

          <ReachoutPanel
            assignments={assignments}
            florists={florists}
            engagement={engagement}
            testMode={testMode}
            workflowMode={workflowMode}
            currency={order.currency}
            orderStatus={order.status}
            orderDeletedAt={order.deleted_at}
            deliveryLat={order.delivery_lat}
            deliveryLng={order.delivery_lng}
            defaultOpen={reachoutsOpenByDefault}
          />

          <CollapseCard id="communications" title="Communications" peek={commsPeek} open={commsFailedCount > 0}>
            <OrderCommunications communications={communications} />
          </CollapseCard>

          <div className="card">
            <div className="mini-h" style={{ marginBottom: 10 }}>Payment &amp; payout</div>
            <dl className="kv">
              <dt>Items</dt><dd>{itemsSum != null ? formatMoney(itemsSum, order.currency) : "—"}</dd>
              <dt>Shipping</dt><dd>{formatMoney(order.shipping_total, order.currency)}</dd>
              <dt>Total</dt><dd>{formatMoney(order.total, order.currency)}</dd>
              <dt>Payment</dt><dd>{order.financial_status ?? "—"}</dd>
            </dl>
            {payouts.length === 0 ? (
              <p style={{ marginTop: 8, color: "var(--ink-faint)", fontSize: ".85rem" }}>No payout legs yet.</p>
            ) : (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                {payouts.map((p) => (
                  <div key={p.id} style={{ display: "grid", gap: 6 }}>
                    <Link href={`/payments/${p.id}`} className="tx-link" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: ".85rem" }} title="View payment record">
                      <span>{legLabel(p.leg)} <span style={{ color: "var(--ink-faint)" }}>· {p.rail ?? "—"}</span></span>
                      <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <b>{formatMoney(p.amount, p.currency ?? order.currency)}</b>
                        <span className={`badge ${payoutStatusBadgeCls(p.status)}`}>{p.status === "held" ? "held — review" : p.status}</span>
                      </span>
                    </Link>
                    {p.status === "held" && canManagePayouts && (
                      <div style={{ display: "flex", gap: 6 }}>
                        <Button variant="solid" disabled={anyBusy} onClick={() => payoutAction(p.id, "approve")}>Approve release</Button>
                        <Button variant="warn" disabled={anyBusy} onClick={() => payoutAction(p.id, "reject")}>Reject proof</Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {canManagePayouts && canReleaseWithoutPhoto && (
              <div style={{ marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
                {!releaseOpen ? (
                  <Button variant="ghost" disabled={anyBusy} onClick={() => { setReleaseOpen(true); setActionError(null); }}>Release without photo…</Button>
                ) : (
                  <div style={{ display: "grid", gap: 6 }}>
                    <label style={{ fontSize: ".8rem", color: "var(--ink-soft)" }}>Why release without a proof photo? (recorded on the payout + timeline)</label>
                    <input
                      value={releaseReason}
                      onChange={(e) => setReleaseReason(e.target.value)}
                      placeholder="e.g. florist confirmed delivery by phone; photo upload failed"
                      style={{ padding: "6px 8px", fontSize: ".85rem", border: "1px solid var(--line)", borderRadius: 6 }}
                    />
                    <div style={{ display: "flex", gap: 6 }}>
                      <Button variant="solid" disabled={anyBusy} onClick={() => deliverableAssignment && releaseWithoutPhoto(deliverableAssignment.id)}>Release 30%</Button>
                      <Button variant="ghost" disabled={anyBusy} onClick={() => { setReleaseOpen(false); setReleaseReason(""); }}>Cancel</Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="card">
            <div className="mini-h" style={{ marginBottom: 10 }}>Delivery proof</div>
            {photoProofs.length === 0 ? (
              <div className="dropzone">Awaiting delivery photo from florist</div>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
                {photoProofs.map((p) => <DeliveryProofPhoto key={p.id} event={p} onEnlarge={() => setLightboxProof(p)} />)}
              </div>
            )}
            <PhotoVerificationPanel verifications={photoVerifications} />
          </div>

          <CollapseCard title="Shopify write-back" peek={order.fulfillment_status ?? undefined}>
            <dl className="kv">
              <dt>Fulfillment</dt><dd>{order.fulfillment_status ?? "—"}</dd>
              <dt>Payment</dt><dd>{order.financial_status ?? "—"}</dd>
            </dl>
          </CollapseCard>
        </div>
      </div>

      <CollapseCard title="Timeline" peek={events.length ? `${events.length} event${events.length === 1 ? "" : "s"}` : undefined}>
        {events.length === 0 && <p style={{ color: "var(--ink-faint)", fontSize: ".9rem" }}>No events.</p>}
        {events.length > 0 && (
          <ul className="timeline">
            {events.map((e) => (
              <li key={e.id} className="timeline-event">
                <span className="dot" />
                <div>{eventLabel(e.type)}</div>
                <div style={{ color: "var(--ink-faint)", fontSize: ".78rem", marginTop: 2 }}>
                  {e.actor ?? "system"} · <time dateTime={e.created_at}>{formatRelative(e.created_at)}</time> · {formatDateTime(e.created_at)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CollapseCard>

      {lightboxProof?.photo_key && (
        <PhotoLightbox
          src={`/api/orders/photo?key=${encodeURIComponent(lightboxProof.photo_key)}`}
          alt={`${proofLabel(lightboxProof.type)} delivery proof, enlarged`}
          caption={`${proofLabel(lightboxProof.type)} · ${formatDateTime(lightboxProof.created_at)}`}
          onClose={() => setLightboxProof(null)}
        />
      )}
    </main>
  );
}
