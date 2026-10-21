"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import AddFloristDialog from "@/components/florists/AddFloristDialog";
import Badge from "@/components/ui/Badge";
import EmptyState from "@/components/EmptyState";
import ErrorState from "@/components/ErrorState";
import StatTile from "@/components/StatTile";
import {
  IconAlertTriangle,
  IconBuildingStorefront,
  IconClock,
  IconLayers,
  IconMail,
  IconPhone,
  IconShoppingCart,
} from "@/components/icons";
import { LIFECYCLE_STAGES, STAGE_LABEL } from "@/lib/pipeline";
import { formatMoney } from "@/components/orders/format";
import type { Florist, LifecycleStage } from "@/lib/types";
import { pageTitle } from "@/lib/brand";

/** Nested-select row shape from the server page's florists query, plus
 * server-computed operational load + track record (active/pending/history/paid).
 *
 * Deliberately a `Pick`, not the whole `Florist`: the page fetches the full
 * ~3.4k-row roster (it filters client-side, so it has to), and `select("*")`
 * dragged every enrichment column — including long text like `drafted_email`
 * and `enrichment_notes` — across the wire at ~1.7 MB per 1000 rows. These are
 * the only columns this table renders; keep the two in step. */
export type FloristRow = Pick<
  Florist,
  "id" | "name" | "trust_tier" | "lifecycle_stage" | "phone_web" | "phone_maps" | "email"
> & {
  cities: { city: string; country: string } | null;
  activeOrders?: number;
  pendingOffers?: number;
  historyCount?: number;
  paidTotal?: number;
  paidCurrency?: string | null;
};

const COLS = 8;

/** trust_tiers.code, best to worst — the table's own ordering. */
const TRUST_TIER_CODES = ["1", "2", "3", "4"] as const;

// No shared {label,variant} map exists yet for lifecycle stage (only
// STAGE_LABEL, a label-only map, in lib/pipeline.ts — reused below) or trust
// tier (components/orders/badges.ts has one, but that file is out of scope
// for this change per the owning-files list, and other engineers are
// actively retinting it). Variant choices here are a local, POC-reasonable
// mapping: trust tier mirrors the trust_tiers table's own trust ordering
// (1 best -> 4 worst); lifecycle stage mirrors lib/pipeline.ts's phase
// grouping (discovery -> engagement -> onboarding -> production, "lost" as
// a dead-end).
function tierBadgeCls(code: Florist["trust_tier"]): string {
  switch (code) {
    case "1": return "badge-accent";
    case "2": return "badge-amber";
    case "3": return "badge-neutral";
    case "4": return "badge-crit";
    default: return "badge-neutral";
  }
}

function tierRowClass(code: Florist["trust_tier"]): string {
  switch (code) {
    case "1": return "row-tier-1";
    case "2": return "row-tier-2";
    case "3": return "row-tier-3";
    case "4": return "row-tier-4";
    default: return "";
  }
}

function SkeletonRows({ rows = 8 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i}>
          <td colSpan={COLS}>
            <div className="skeleton-row">
              <span className="skeleton" style={{ width: 140, height: 14 }} />
              <span className="skeleton" style={{ width: 90, height: 14 }} />
              <span className="skeleton" style={{ width: 60, height: 14 }} />
              <span className="skeleton" style={{ width: 70, height: 14 }} />
              <span className="skeleton" style={{ width: 90, height: 14 }} />
              <span className="skeleton" style={{ width: 50, height: 14 }} />
              <span className="skeleton" style={{ width: 40, height: 14, marginLeft: "auto" }} />
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}

export default function FloristsDirectory({ florists, error }: { florists: FloristRow[]; error: string | null }) {
  // One-frame skeleton on mount — matches components/orders/OrdersClient.tsx's
  // pattern: data is already server-fetched (no client refetch), this just
  // keeps the loading affordance consistent across staff screens.
  const [ready, setReady] = useState(false);
  const [adding, setAdding] = useState(false);
  const router = useRouter();
  useEffect(() => setReady(true), []);

  const [search, setSearch] = useState("");
  const [cityFilter, setCityFilter] = useState<string | null>(null);
  const [tierFilter, setTierFilter] = useState<string | null>(null);
  // Default to the live, order-taking partners (lifecycle_stage 'production' —
  // the same set the matcher treats as eligible). Pipeline florists are one
  // click away via the stage filter.
  const [stageFilter, setStageFilter] = useState<LifecycleStage | null>("production");

  const cityOptions = useMemo(
    () => Array.from(new Set(florists.map((f) => f.cities?.city).filter((c): c is string => !!c))).sort(),
    [florists]
  );
  const tierOptions = useMemo(
    () => TRUST_TIER_CODES.filter((t) => florists.some((f) => f.trust_tier === t)),
    [florists]
  );
  const stageOptions = useMemo(
    () => LIFECYCLE_STAGES.filter((s) => florists.some((f) => f.lifecycle_stage === s)),
    [florists]
  );

  const activeFilterCount =
    (search.trim() ? 1 : 0) + (cityFilter ? 1 : 0) + (tierFilter ? 1 : 0) + (stageFilter ? 1 : 0);

  // "Current state" tiles — control-panel-style glance numbers, built entirely
  // from the roster already fetched (no extra queries). Production partners /
  // missing-contact are deliberately whole-roster (not affected by the city/
  // tier/search filters below) — they're roster health, not "what am I
  // looking at right now". Active/pending mirror the filtered table beneath
  // them, so they always agree with what's on screen.
  const rosterStats = useMemo(() => {
    const production = florists.filter((f) => f.lifecycle_stage === "production");
    const missingContact = production.filter((f) => !f.phone_web && !f.phone_maps && !f.email).length;
    return { productionCount: production.length, missingContact };
  }, [florists]);

  function clearFilters() {
    setSearch("");
    setCityFilter(null);
    setTierFilter(null);
    setStageFilter(null);
  }

  const filtered = useMemo(() => {
    let rows = florists;
    const q = search.trim().toLowerCase();
    if (q) rows = rows.filter((f) => f.name.toLowerCase().includes(q));
    if (cityFilter) rows = rows.filter((f) => f.cities?.city === cityFilter);
    if (tierFilter) rows = rows.filter((f) => f.trust_tier === tierFilter);
    if (stageFilter) rows = rows.filter((f) => f.lifecycle_stage === stageFilter);
    // Order by operational grouping: country → city → busiest first.
    return [...rows].sort((a, b) => {
      const ac = a.cities?.country ?? "￿";
      const bc = b.cities?.country ?? "￿";
      if (ac !== bc) return ac.localeCompare(bc);
      const acity = a.cities?.city ?? "￿";
      const bcity = b.cities?.city ?? "￿";
      if (acity !== bcity) return acity.localeCompare(bcity);
      const aa = a.activeOrders ?? 0;
      const ba = b.activeOrders ?? 0;
      if (aa !== ba) return ba - aa;
      return a.name.localeCompare(b.name);
    });
  }, [florists, search, cityFilter, tierFilter, stageFilter]);

  const viewStats = useMemo(
    () => ({
      activeOrders: filtered.reduce((sum, f) => sum + (f.activeOrders ?? 0), 0),
      pendingOffers: filtered.reduce((sum, f) => sum + (f.pendingOffers ?? 0), 0),
    }),
    [filtered]
  );

  if (error) {
    return (
      <main className="ds page">
        <p className="eyebrow">Partners</p>
        <h1>{pageTitle("Florists")}</h1>
        <div style={{ marginTop: 24 }}>
          <ErrorState
            title="Couldn't load florists"
            description="Something went wrong fetching data from Supabase. This is a fetch error, not an empty roster — your florists are still there."
          />
        </div>
      </main>
    );
  }

  return (
    <main className="ds page">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <p className="eyebrow">Partners</p>
          <h1>{pageTitle("Florists")}</h1>
        </div>
        {/* The only way into the system that isn't an Apify scrape — for shops
            we already work with, who were never going to appear in one. */}
        <button type="button" className="btn btn-solid" onClick={() => setAdding(true)}>
          Add a florist
        </button>
      </div>

      {adding && (
        <AddFloristDialog
          // The canonical four, NOT tierOptions — that one is derived from the
          // tiers present in the loaded roster (it drives the filter chips), so
          // a tier no current florist happens to hold would be unofferable here.
          tiers={TRUST_TIER_CODES}
          onClose={() => setAdding(false)}
          onCreated={() => router.refresh()}
        />
      )}

      {florists.length === 0 ? (
        <div style={{ marginTop: 24 }}>
          <EmptyState
            icon={<IconBuildingStorefront className="h-12 w-12 text-ink-faint" />}
            title="No florists yet"
            description="Florists will show up here once a city has been ingested."
          />
        </div>
      ) : (
        <>
          <section className="mt-4">
            <p className="mini-h mb-3">Current state</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <StatTile
                label={`Visible · of ${florists.length.toLocaleString()}`}
                value={filtered.length.toLocaleString()}
                accent="slate"
                icon={<IconLayers className="h-4 w-4" />}
              />
              <StatTile
                label="Active orders"
                value={viewStats.activeOrders}
                accent={viewStats.activeOrders > 0 ? "emerald" : "slate"}
                icon={<IconShoppingCart className="h-4 w-4" />}
              />
              <StatTile
                label="Pending offers"
                value={viewStats.pendingOffers}
                accent={viewStats.pendingOffers > 0 ? "amber" : "slate"}
                icon={<IconClock className="h-4 w-4" />}
              />
              <StatTile
                label="Production partners"
                value={rosterStats.productionCount}
                accent="emerald"
                icon={<IconBuildingStorefront className="h-4 w-4" />}
              />
              <StatTile
                label="Missing contact · production"
                value={rosterStats.missingContact}
                accent={rosterStats.missingContact > 0 ? "red" : "emerald"}
                icon={<IconAlertTriangle className="h-4 w-4" />}
              />
            </div>
          </section>

          <div className="filterbar" style={{ marginTop: 16 }}>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name…"
              aria-label="Search florists by name"
              style={inputStyle}
            />

            <label className="sr-only" htmlFor="florists-city-filter">City</label>
            <select
              id="florists-city-filter"
              value={cityFilter ?? ""}
              onChange={(e) => setCityFilter(e.target.value || null)}
              className={`filter-trigger${cityFilter ? " on" : ""}`}
              style={selectStyle}
            >
              <option value="">All cities</option>
              {cityOptions.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>

            <label className="sr-only" htmlFor="florists-tier-filter">Trust tier</label>
            <select
              id="florists-tier-filter"
              value={tierFilter ?? ""}
              onChange={(e) => setTierFilter(e.target.value || null)}
              className={`filter-trigger${tierFilter ? " on" : ""}`}
              style={selectStyle}
            >
              <option value="">All trust tiers</option>
              {tierOptions.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>

            <label className="sr-only" htmlFor="florists-stage-filter">Lifecycle stage</label>
            <select
              id="florists-stage-filter"
              value={stageFilter ?? ""}
              onChange={(e) => setStageFilter((e.target.value || null) as LifecycleStage | null)}
              className={`filter-trigger${stageFilter ? " on" : ""}`}
              style={selectStyle}
            >
              <option value="">All lifecycle stages</option>
              {stageOptions.map((s) => (
                <option key={s} value={s}>{STAGE_LABEL[s]}</option>
              ))}
            </select>

            {activeFilterCount > 0 && (
              <button type="button" className="btn btn-ghost" onClick={clearFilters}>
                Clear filters
              </button>
            )}
          </div>

          <div className="card" style={{ padding: 0, overflow: "hidden", marginTop: 12 }}>
            {filtered.length === 0 && ready ? (
              <div style={{ padding: 8 }}>
                <EmptyState
                  icon={<IconBuildingStorefront className="h-12 w-12 text-ink-faint" />}
                  title="No florists match these filters"
                  description="Try widening your filters, or clear them to see the full roster."
                  action={
                    <button type="button" className="btn btn-ghost" onClick={clearFilters}>
                      Clear filters
                    </button>
                  }
                />
              </div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Country</th>
                    <th>City</th>
                    <th>Florist</th>
                    <th>Tier</th>
                    <th style={{ textAlign: "right" }}>Active</th>
                    <th style={{ textAlign: "right" }}>Offers</th>
                    <th style={{ textAlign: "right" }}>History</th>
                    <th style={{ textAlign: "right" }}>Paid out</th>
                  </tr>
                </thead>
                <tbody>
                  {!ready ? (
                    <SkeletonRows />
                  ) : (
                    filtered.map((f) => {
                      const phone = f.phone_web ?? f.phone_maps;
                      const contactHint = [phone ? `☎ ${phone}` : null, f.email ? `✉ ${f.email}` : null].filter(Boolean).join("  ") || "No contact on file";
                      const active = f.activeOrders ?? 0;
                      return (
                        <tr key={f.id} className={tierRowClass(f.trust_tier)} onClick={() => { location.href = `/florists/${f.id}`; }} style={{ cursor: "pointer" }}>
                          <td style={{ color: "var(--ink-soft)" }}>{f.cities?.country ?? "—"}</td>
                          <td style={{ color: "var(--ink-soft)" }}>{f.cities?.city ?? "—"}</td>
                          <td>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                              <Link href={`/florists/${f.id}`} style={{ fontWeight: 600 }} onClick={(e) => e.stopPropagation()}>
                                {f.name}
                              </Link>
                              <span title={contactHint} aria-label={contactHint} style={{ display: "inline-flex", gap: 3, color: "var(--ink-faint)" }}>
                                {phone && <IconPhone className="h-3.5 w-3.5" />}
                                {f.email && <IconMail className="h-3.5 w-3.5" />}
                              </span>
                            </span>
                          </td>
                          <td>
                            <Badge info={{ cls: tierBadgeCls(f.trust_tier), label: f.trust_tier ?? "—" }} />
                          </td>
                          <td className="num" style={{ textAlign: "right", fontWeight: active > 0 ? 700 : 400, color: active > 0 ? "var(--ink)" : "var(--ink-faint)" }}>{active}</td>
                          <td className="num" style={{ textAlign: "right", color: (f.pendingOffers ?? 0) > 0 ? "var(--ink)" : "var(--ink-faint)" }}>{f.pendingOffers ?? 0}</td>
                          <td className="num" style={{ textAlign: "right", color: "var(--ink-soft)" }}>{f.historyCount ?? 0}</td>
                          <td className="num" style={{ textAlign: "right" }}>{(f.paidTotal ?? 0) > 0 ? formatMoney(f.paidTotal ?? 0, f.paidCurrency ?? null) : "—"}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  font: "600 .8rem/1 var(--sans)",
  padding: "7px 12px",
  borderRadius: 8,
  border: "1px solid var(--line-strong)",
  background: "var(--surface)",
  color: "var(--ink)",
  minWidth: 200,
};

const selectStyle: React.CSSProperties = {
  font: "600 .8rem/1 var(--sans)",
  padding: "7px 10px",
  borderRadius: 8,
  border: "1px solid var(--line-strong)",
  background: "var(--surface)",
  color: "var(--ink-soft)",
};
