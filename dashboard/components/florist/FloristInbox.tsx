"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import BouquetPhoto from "@/components/florist/BouquetPhoto";
import IngredientList from "@/components/florist/IngredientList";
import { useT } from "@/components/florist/LocaleProvider";
import { formatKm as fmtKm } from "@/lib/geo";
import { splitOfferItems } from "@/lib/offerItems";

type LineItem = { title: string | null; image_url: string | null; bouquet_spec: string | null; quantity: number; product_type: string | null; unit_price: number | null; line_total: number | null };
type Row = {
  id: string;
  status: string;
  offer_kind: string | null;
  payout_price: number | null;
  distance_km?: number | null;
  orders: {
    order_name: string | null;
    delivery_area: string | null;
    delivery_at: string | null;
    order_line_items?: LineItem[];
  } | null;
};

type ViewMode = "cards" | "table";
const VIEW_STORAGE_KEY = "fc-florist-inbox-view";
const TABLE_DEFAULT_THRESHOLD = 8;

function timeLabel(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
}

/** Below 768px (or on first paint, before we know) cards win; wide viewports
 * or a busy inbox (>8 open offers) default to the table — unless the florist
 * has already made an explicit choice (see the effect below). */
function computeDefaultView(openCount: number): ViewMode {
  if (typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches) return "table";
  return openCount > TABLE_DEFAULT_THRESHOLD ? "table" : "cards";
}

export default function FloristInbox({ rows }: { rows: Row[] }) {
  const { t } = useT();

  function dayLabel(iso: string | null): string {
    if (!iso) return t("ui.offer.inbox.unscheduled");
    const d = new Date(iso).setHours(0, 0, 0, 0); const now = new Date().setHours(0, 0, 0, 0);
    const days = Math.round((d - now) / 86400000);
    if (days === 0) return t("ui.offer.inbox.today"); if (days === 1) return t("ui.offer.inbox.tomorrow");
    return new Date(iso).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
  }
  function offer(r: Row) {
    return r.status === "accepted" ? { cls: "badge-accent", label: t("ui.offer.inbox.badgeAccepted") }
      : r.offer_kind === "exclusive" ? { cls: "badge-accent", label: t("ui.offer.inbox.badgeReserved") } : { cls: "badge-warn", label: t("ui.offer.inbox.badgeFirstToAccept") };
  }

  const openCount = rows.filter((r) => r.status !== "accepted").length;
  // SSR-safe: both server and first client render use "cards"; the real
  // default (media query / stored preference) is resolved post-mount.
  const [view, setView] = useState<ViewMode>("cards");

  useEffect(() => {
    let stored: string | null = null;
    try { stored = window.localStorage.getItem(VIEW_STORAGE_KEY); } catch { /* localStorage unavailable */ }
    if (stored === "cards" || stored === "table") setView(stored);
    else setView(computeDefaultView(openCount));
    // Only resolve the initial default once per mount — later prop changes
    // (e.g. a background refresh) shouldn't yank the florist between views.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function choose(next: ViewMode) {
    setView(next);
    try { window.localStorage.setItem(VIEW_STORAGE_KEY, next); } catch { /* localStorage unavailable */ }
  }

  // Split the inbox: offers still awaiting the florist's accept/decline go up
  // top (they need action); already-accepted orders sit below.
  const waiting = rows.filter((r) => r.status !== "accepted");
  const accepted = rows.filter((r) => r.status === "accepted");

  const sectionTitle: React.CSSProperties = { fontSize: "1.05rem", fontWeight: 720, letterSpacing: "-.01em", margin: 0 };

  function renderDayGroups(sectionRows: Row[]) {
    const groups = new Map<string, Row[]>();
    for (const r of sectionRows) { const k = dayLabel(r.orders?.delivery_at ?? null); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
    return [...groups.entries()].map(([day, list]) => (
      <div key={day} style={{ marginTop: 14 }}>
        <div className="mini-h">{day}</div>
        {view === "cards" ? (
            <div className="fc-card-grid">
              {list.map((r) => {
                const o = offer(r);
                const items = r.orders?.order_line_items ?? [];
                // Same hero pick as the pre-accept offer page (lib/offerItems.ts):
                // `product_type` is unreliable (988/1000 rows say "bouquet",
                // including greeting cards), so the hero is chosen by recipe/value,
                // never an add-on, even when one happens to sort first.
                const { hero: heroItem } = splitOfferItems(items);
                const bouquets = items.filter((it) => it.product_type === "bouquet");
                const heroAlt = heroItem?.title ?? r.orders?.order_name ?? t("ui.offer.inbox.bouquetAlt");
                return (
                  <Link key={r.id} href={`/florist/orders/${r.id}`} className="ocard" style={{ display: "block", padding: 0, overflow: "hidden" }}>
                    <div style={{ position: "relative", aspectRatio: "4 / 3" }}>
                      <BouquetPhoto src={heroItem?.image_url} alt={heroAlt} style={{ width: "100%", height: "100%" }} />
                      <div
                        aria-hidden
                        style={{ position: "absolute", inset: 0, background: "linear-gradient(to bottom, rgba(10,20,15,.45), transparent 55%)", pointerEvents: "none" }}
                      />
                      <span className={`badge ${o.cls}`} style={{ position: "absolute", top: 8, right: 8 }}>{o.label}</span>
                      {bouquets.length > 1 && (
                        <span className="badge badge-neutral" style={{ position: "absolute", top: 8, left: 8 }}>{t("ui.offer.inbox.bouquetsCount", { count: bouquets.length })}</span>
                      )}
                    </div>
                    <div style={{ padding: 13, display: "grid", gap: 6 }}>
                      <b>{r.orders?.order_name ?? "—"}</b>
                      <div style={{ color: "var(--ink-soft)", fontSize: ".85rem" }}>
                        {r.orders?.delivery_area ?? "—"} · {timeLabel(r.orders?.delivery_at ?? null)}
                        {fmtKm(r.distance_km) ? ` · ${fmtKm(r.distance_km)}` : ""}
                      </div>
                      {r.payout_price != null && <div className="payout"><span>{t("ui.offer.inbox.yourPayout")}</span><b>€{r.payout_price}</b></div>}
                      {items.length > 0 && (
                        <div style={{ marginTop: 2 }}>
                          <div className="mini-h" style={{ marginBottom: 6 }}>{t("ui.offer.inbox.whatToMake")}</div>
                          <div className="spec-list">
                            {items.map((it, i) => (
                              <div key={i} className="spec-row" style={{ alignItems: "flex-start" }}>
                                <BouquetPhoto src={it.image_url} alt="" style={{ width: 32, height: 32, borderRadius: 7, flexShrink: 0 }} />
                                <div style={{ flex: 1 }}>
                                  <span style={{ color: "var(--ink)" }}>{it.title ?? t("ui.offer.inbox.itemFallback")} ×{it.quantity}</span>
                                  <IngredientList spec={it.bouquet_spec} />
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          ) : (
            <div className="card" style={{ padding: 0, overflowX: "auto", marginTop: 8, WebkitOverflowScrolling: "touch" }}>
              {/* width:100% + wrapping cells (below) let all columns fit the
                  viewport without horizontal scroll; overflowX is just a safety
                  net for very narrow screens. */}
              <table className="data-table fc-inbox-table">
                <thead><tr><th>{t("ui.offer.inbox.colOrder")}</th><th>{t("ui.offer.inbox.colArea")}</th><th>{t("ui.offer.inbox.colDist")}</th><th>{t("ui.offer.inbox.colTime")}</th><th>{t("ui.offer.inbox.colOffer")}</th><th>{t("ui.offer.inbox.colPayout")}</th></tr></thead>
                <tbody>
                  {list.map((r) => {
                    const o = offer(r);
                    return (
                      <tr key={r.id} onClick={() => { location.href = `/florist/orders/${r.id}`; }}>
                        <td style={{ whiteSpace: "nowrap" }}><Link href={`/florist/orders/${r.id}`} style={{ fontWeight: 700 }}>{r.orders?.order_name ?? "—"}</Link></td>
                        <td style={{ color: "var(--ink-soft)", minWidth: 70 }}>{r.orders?.delivery_area ?? "—"}</td>
                        <td style={{ color: "var(--ink-soft)", whiteSpace: "nowrap" }}>{fmtKm(r.distance_km) ?? "—"}</td>
                        <td style={{ color: "var(--ink-soft)" }}>{timeLabel(r.orders?.delivery_at ?? null)}</td>
                        <td><span className={`badge ${o.cls}`}>{o.label}</span></td>
                        <td style={{ whiteSpace: "nowrap" }}>{r.payout_price != null ? `€${r.payout_price}` : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
    ));
  }

  return (
    <main className="ds page">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1>{t("ui.offer.inbox.title")}</h1>
        </div>
        <div className="segmented" role="tablist" aria-label={t("ui.offer.inbox.layoutAriaLabel")}>
          <button type="button" role="tab" aria-selected={view === "cards"} className={view === "cards" ? "on" : ""} onClick={() => choose("cards")}>{t("ui.offer.inbox.viewCards")}</button>
          <button type="button" role="tab" aria-selected={view === "table"} className={view === "table" ? "on" : ""} onClick={() => choose("table")}>{t("ui.offer.inbox.viewTable")}</button>
        </div>
      </div>

      {rows.length === 0 && <p style={{ color: "var(--ink-faint)", marginTop: 12 }}>{t("ui.offer.inbox.empty")}</p>}

      {waiting.length > 0 && (
        <section style={{ marginTop: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h2 style={sectionTitle}>{t("ui.offer.inbox.waitingTitle")}</h2>
            <span className="badge badge-warn">{waiting.length}</span>
          </div>
          <p style={{ color: "var(--ink-soft)", fontSize: ".84rem", marginTop: 4 }}>{t("ui.offer.inbox.waitingSubtitle")}</p>
          {renderDayGroups(waiting)}
        </section>
      )}

      {accepted.length > 0 && (
        <section style={{ marginTop: 26 }}>
          <h2 style={sectionTitle}>{t("ui.offer.inbox.acceptedTitle")}</h2>
          <p style={{ color: "var(--ink-soft)", fontSize: ".84rem", marginTop: 4 }}>{t("ui.offer.inbox.acceptedSubtitle")}</p>
          {renderDayGroups(accepted)}
        </section>
      )}
    </main>
  );
}
