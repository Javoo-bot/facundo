"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CALL_DECLINE_REASONS, type CallOutcome } from "@/lib/callCard";

/** Everything the card renders, resolved on the server. The client component
 *  holds no domain logic — only which dropdown is open and what to POST. */
export interface CallCardSubject {
  assignmentId: string;
  floristId: string;
  name: string;
  /** Null when we hold no number — the card then says so instead of showing a blank. */
  phone: string | null;
  coldLead: boolean;
  /** "5.0★ 432 Google reviews · 4.7 km from the delivery address" */
  facts: string | null;
  /** "No contact name on file — ask who handles the orders." */
  who: string;
  /** One sentence of fact about this offer. Never an instruction. */
  offerLine: string;
  /** Why they can't be called, or null. */
  uncallable: string | null;
  /** "You called 20 minutes ago — nobody answered." Null if we never have. */
  lastCall: string | null;
  /** Already holds the order — the call is "how is it going", not "will you take it". */
  isHolder: boolean;
}

export interface CallCardHistory {
  summary: string;
  refusals: { when: string | null; reason: string | null; detail: string | null; orderName: string | null; isThisOrder: boolean }[];
}

export default function CallCard({
  orderId, orderName, dueLabel, dueTone,
  itemTitle, itemSub, itemImage, destination, whenLine, payout,
  subject, history, canAct, noSubjectNote,
}: {
  orderId: string;
  orderName: string;
  dueLabel: string | null;
  dueTone: "warn" | "crit";
  itemTitle: string | null;
  itemSub: string | null;
  itemImage: string | null;
  destination: string;
  whenLine: string | null;
  payout: string | null;
  subject: CallCardSubject | null;
  history: CallCardHistory | null;
  canAct: boolean;
  /** Why there is nobody to call, when there is nobody. See
   *  lib/callCard.ts::noSubjectReason — "we haven't asked anyone" and
   *  "everyone said no" are different problems and must not read alike. */
  noSubjectNote: string;
}) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<CallOutcome | "">("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function commit() {
    if (!subject || !outcome) return;
    setBusy(true);
    setError(null);
    try {
      // Nobody picked up. This used to navigate away writing nothing, which
      // handed the next operator the same shop and the same number with no hint
      // it had just been rung. It is now recorded like any other outcome.
      if (outcome === "no_answer") {
        const res = await fetch("/api/orders/call-outcome", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assignmentId: subject.assignmentId, outcome: "no_answer" }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          setError(j.error ?? "That didn't save. Try again.");
          return;
        }
        back();
        return;
      }
      const res = outcome === "accepted"
        // Accepting has real consequences — payout leg, Shopify write-back,
        // florist and client comms — and they already live in this route.
        ? await fetch("/api/orders/reachout", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ assignmentId: subject.assignmentId, action: "accept" }),
          })
        : await fetch("/api/orders/call-outcome", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ assignmentId: subject.assignmentId, reason: reason || null, note: note || null }),
          });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j.error ?? "That didn't save. Try again."); return; }
      back();
    } finally {
      setBusy(false);
    }
  }

  /** Back to the Control panel, which recomputes what this order needs now.
   *  The card deliberately does not offer a next shop or a "find more" button:
   *  one queue decides what happens next, and it is not this screen. */
  function back() {
    router.push("/");
    router.refresh();
  }

  const ACTION_LABEL: Record<CallOutcome, string> = {
    accepted: subject ? `Assign to ${subject.name}` : "Assign",
    refused: "Save and go back",
    no_answer: "Go back",
  };
  const ACTION_HINT: Record<CallOutcome, string> = {
    accepted: "Sends the confirmation and releases the first payout leg.",
    refused: "Twenty seconds, tops. If nothing useful came out, save it empty.",
    no_answer: "Recorded, so the next person knows you tried.",
  };

  return (
    <div className="cs-min">

      {/* Identity, the deadline, and the way back to everything else. No stage
          stepper, no test-mode badge, no re-pull/delete/change-stage. */}
      <div className="cs-minbar">
        <Link href="/" className="link-subtle" style={{ color: "var(--ink-faint)" }}>← Control panel</Link>
        <span className="cs-minbar-id">{orderName}</span>
        {dueLabel && (
          <span className="cs-minbar-due" style={dueTone === "crit" ? { color: "var(--crit)" } : undefined}>{dueLabel}</span>
        )}
      </div>

      <div className="cs-slab">

        {/* THE ASK. The bouquet is shown, not described. */}
        <div className="cs-slab-l">
          <div>
            {itemImage
              ? <img className="cs-photo" src={itemImage} alt={itemTitle ?? "The bouquet"} />
              : <div className="cs-photo" style={{ display: "grid", placeItems: "center", color: "var(--ink-faint)", font: "600 .76rem/1.4 var(--mono)", textAlign: "center", padding: 12 }}>
                  No product image
                </div>}
            <p className="cs-item">
              {itemTitle ?? "No line items on this order"}
              {itemSub && <small>{itemSub}</small>}
            </p>
          </div>

          <div className="cs-where">
            <b>{destination}</b>
            {whenLine}
          </div>

          {payout && (
            <div className="cs-money">
              <div className="cs-lbl">They get paid</div>
              <div className="cs-money-v">{payout}</div>
              <p className="cs-money-n">Fixed. Not negotiable on this call.</p>
            </div>
          )}
        </div>

        {/* THE PERSON, AND THE ANSWER. */}
        <div className="cs-slab-r">
          {!subject ? (
            <div>
              <h1 className="cs-shop">Nobody to call yet</h1>
              <p className="cs-shop-facts">{noSubjectNote}</p>
              {/* Finding shops is the Control panel's job, not this screen's —
                  the card only ever knows how to be one phone call. */}
              <p style={{ marginTop: 20 }}>
                <Link href="/" className="btn btn-solid" style={{ textDecoration: "none" }}>Back to Control panel</Link>
              </p>
            </div>
          ) : (
            <>
              <h1 className="cs-shop">{subject.name}</h1>

              <div style={{ marginTop: 13, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <span className={`cs-rel ${subject.isHolder ? "cs-rel-member" : subject.coldLead ? "cs-rel-cold" : "cs-rel-member"}`}>
                  {subject.isHolder ? "Has this order" : subject.coldLead ? "Cold lead · never worked with us" : "In the network"}
                </span>
              </div>

              {subject.facts && <p className="cs-shop-facts">{subject.facts}</p>}
              <p className="cs-shop-who">{subject.who}</p>

              {/* Sits ABOVE the number on purpose: it is the one fact that
                  should change whether you dial at all, so it has to be read
                  before the phone is picked up rather than after. */}
              {subject.lastCall && (
                <p style={{ margin: "10px 0 0", fontSize: ".88rem", fontWeight: 600, color: "var(--warn)" }}>
                  {subject.lastCall}
                </p>
              )}

              {/* The number, and how it went. Dialling happens on a real phone,
                  so there is no call button — just the number, large. */}
              <div className="cs-dialbar">
                <div className="cs-dialrow">
                  {subject.phone
                    ? <span className="cs-mintel">{subject.phone}</span>
                    : <span className="cs-mintel" style={{ color: "var(--crit)", fontSize: "1rem", fontWeight: 700, fontFamily: "var(--mono)" }}>
                        {subject.uncallable}
                      </span>}

                  {subject.phone && canAct && (
                    <span className="cs-outsel">
                      <label className="cs-outsel-l" htmlFor="cc-outcome">How did it go?</label>
                      <select
                        className="cs-sel"
                        id="cc-outcome"
                        value={outcome}
                        disabled={busy}
                        onChange={(e) => { setOutcome(e.target.value as CallOutcome | ""); setError(null); }}
                      >
                        <option value="">&mdash;</option>
                        {!subject.isHolder && <option value="accepted">Accepted</option>}
                        <option value="refused">Refused</option>
                        <option value="no_answer">No answer</option>
                      </select>
                    </span>
                  )}
                </div>

                {/* ONE follow-up area and ONE action button, whichever outcome
                    is chosen — so "Save" is never on screen twice. */}
                {outcome && (
                  <div className="cs-follow">
                    {outcome === "accepted" && (
                      <p style={{ margin: 0, fontSize: ".92rem", lineHeight: 1.55, color: "var(--ink-soft)" }}>
                        {subject.name} takes this order{payout ? <> and gets <b style={{ color: "var(--ink)" }}>{payout}</b></> : null}
                        &nbsp;&mdash; 70% straight away, 30% when the delivery photo lands.
                      </p>
                    )}

                    {outcome === "refused" && (
                      <div className="cs-refused">
                        <div className="cs-follow-row">
                          <label className="cs-outsel-l" htmlFor="cc-reason">Why?</label>
                          <select
                            className="cs-sel" id="cc-reason" style={{ minWidth: 236 }}
                            value={reason} disabled={busy}
                            onChange={(e) => setReason(e.target.value)}
                          >
                            <option value="">&mdash;</option>
                            {CALL_DECLINE_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                          </select>
                        </div>
                        <textarea
                          className="cs-words"
                          placeholder="What they said, if it's worth keeping."
                          value={note} disabled={busy}
                          onChange={(e) => setNote(e.target.value)}
                        />
                      </div>
                    )}

                    <div className="cs-follow-row">
                      <button className="btn btn-solid" type="button" disabled={busy} onClick={() => void commit()}>
                        {busy ? "Saving…" : ACTION_LABEL[outcome]}
                      </button>
                      <span className="cs-hint">{ACTION_HINT[outcome]}</span>
                    </div>

                    {error && <p style={{ margin: 0, color: "var(--crit)", fontSize: ".86rem" }}>{error}</p>}
                  </div>
                )}
              </div>

              {/* What they did with this offer, and what they have done with us
                  before. Facts and dates. No advice on how to run the call. */}
              <div className="cs-hist">
                <div className="cs-lbl">This offer</div>
                <p className="cs-hist-sum" style={{ color: "var(--ink)" }}>{subject.offerLine}</p>

                {history && (
                  <>
                    <div className="cs-lbl" style={{ marginTop: 22 }}>History with us</div>
                    <p className="cs-hist-sum">{history.summary}</p>
                    {history.refusals.length > 0 && (
                      <div className="cs-hist-list">
                        {history.refusals.map((r, i) => (
                          <div className="cs-hist-row" key={i}>
                            <span className="cs-hist-when">{r.when ?? "—"}</span>
                            <span className="cs-hist-what">
                              {r.isThisOrder ? "This order" : <b>{r.orderName ?? "An earlier order"}</b>}
                              {" — "}
                              {r.reason ? <b>&ldquo;{r.reason}&rdquo;</b> : "no reason given"}
                              {r.detail ? <> &middot; &ldquo;{r.detail}&rdquo;</> : null}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

    </div>
  );
}
