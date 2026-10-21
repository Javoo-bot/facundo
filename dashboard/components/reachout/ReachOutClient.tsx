"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import StatTile from "@/components/StatTile";
import EmptyState from "@/components/EmptyState";
import ErrorState from "@/components/ErrorState";
import { IconCheckCircle, IconMail, IconPhone, IconStar, IconXCircle } from "@/components/icons";
import {
  SPAIN_CITIES,
  scrapeTargets,
  citiesToScrape,
  planIngestRequests,
  estimateSpendUsd,
  PLACES_PER_CITY,
} from "@/lib/reachout/spainCities";
import {
  rankShops,
  collapseDuplicates,
  TIER_LABEL,
  type ReachOutSignals,
  type ReachOutTier,
  type RankedShop,
} from "@/lib/reachout/ranking";

export interface ReachOutSettings {
  sequenceEnabled: boolean;
  autoEnrolScraped: boolean;
  autoEnrolCountries: string[] | null;
  dailySendCap: number | null;
  minGapHours: number | null;
}

/** Tiers CS can actually act on by picking up the phone. Joined shops are shown
 * because the list would look broken without its own successes, but they are
 * not a call — they are the reason the calls are worth making. */
const CALLABLE: ReachOutTier[] = [1, 2];

// The button's own numbers, derived from the city list rather than written into
// the copy. It said "200 cities / ~$20" while the list held 50 — the kind of
// drift that only shows up when someone budgets against the button. Reading
// them here means the label and the cost cannot disagree with what would
// actually run. PLACES_PER_CITY mirrors the cap the operator submits.
const CITY_COUNT = SPAIN_CITIES.length;
// Nine of the fifty are absorbed into a neighbour's circle, so fewer jobs run
// than cities are covered — see spainCities.ts.
const SCRAPE_JOBS = scrapeTargets().length;
const RUN_PLACES = SCRAPE_JOBS * PLACES_PER_CITY;
const RUN_COST_USD = estimateSpendUsd(SCRAPE_JOBS, PLACES_PER_CITY);
// The rehearsal: one real city, named, so nobody has to guess which market the
// $0.10 bought. citiesToScrape truncates in population order.
const TEST_CITY = citiesToScrape({ max: 1 })[0]?.city ?? "one city";
const TEST_COST_USD = estimateSpendUsd(1, PLACES_PER_CITY);

const TIER_ACCENT: Record<ReachOutTier, "good" | "warn" | "crit" | "info" | "muted"> = {
  0: "good", 1: "warn", 2: "info", 3: "muted", 4: "muted", 5: "muted", 6: "crit",
};

function TierPill({ tier }: { tier: ReachOutTier }) {
  const tone = TIER_ACCENT[tier];
  const cls =
    tone === "good" ? "border-[var(--good)] text-[var(--good)]"
    : tone === "warn" ? "border-[var(--warn)] text-[var(--warn)]"
    : tone === "crit" ? "border-[var(--crit)] text-[var(--crit)]"
    : tone === "info" ? "border-accent text-accent"
    : "border-line text-ink-soft";
  return (
    <span className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {TIER_LABEL[tier]}
    </span>
  );
}

/** "20 min", "3 h", "2 d" — the granularity a same-day funnel is read at. An
 * absolute timestamp would make the reader do the subtraction, and the whole
 * question here is how fresh the signal is. */
function ago(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const mins = Math.max(0, Math.round((nowMs - t) / 60000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

type SortColumn = "rank" | "name" | "city" | "signal" | "touches";

export default function ReachOutClient({
  shops,
  failed,
  country,
  settings,
}: {
  shops: ReachOutSignals[];
  failed: boolean;
  country: string;
  settings: ReachOutSettings;
}) {
  const [onlyCallable, setOnlyCallable] = useState(true);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortColumn>("rank");
  // The confirmation is not ceremony: this button spends real money on Apify,
  // and the panel is where the number is stated before it does.
  const [sendConfirm, setSendConfirm] = useState(false);
  const [sending, setSending] = useState<null | "test" | "full">(null);
  const [result, setResult] = useState<null | {
    enqueued: number;
    skipped: number;
    errors: string[];
  }>(null);

  /** Enqueue the campaign. `max` caps how many CITIES run — 1 is the staging
   * rehearsal, which exercises this exact path for ~$0.10 instead of ~$4.
   *
   * One request per radius, because /api/ingest takes a single radius per batch
   * (lib/ingestBatch.ts). Sequential rather than parallel: the batches are a
   * handful, and a failure that names which radius it was beats five concurrent
   * rejections with no order to them.
   *
   * A 409 is NOT an error here. The route returns it when every city in a batch
   * was skipped, and the overwhelmingly common reason is "already running" —
   * re-clicking after a partial run is the normal way to resume, and reporting
   * that as a failure would train people to ignore the failures that matter. */
  const runScrape = async (max?: number) => {
    if (sending) return;
    setSending(max === 1 ? "test" : "full");
    setResult(null);
    let enqueued = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const body of planIngestRequests(max === undefined ? {} : { max })) {
      try {
        const res = await fetch("/api/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = (await res.json().catch(() => ({}))) as {
          enqueued?: unknown[];
          skipped?: unknown[];
          error?: string;
        };
        if (res.status === 409) {
          skipped += body.cities.length;
          continue;
        }
        if (!res.ok) {
          errors.push(`${body.radius} km: ${j.error || `request failed (${res.status})`}`);
          continue;
        }
        enqueued += j.enqueued?.length ?? 0;
        skipped += j.skipped?.length ?? 0;
      } catch (e) {
        errors.push(`${body.radius} km: ${e instanceof Error ? e.message : "request failed"}`);
      }
    }
    setResult({ enqueued, skipped, errors });
    setSending(null);
  };

  // One clock for the whole render. Calling Date.now() inside the scorer would
  // let two rows be scored microseconds apart — harmless numerically, but it
  // would make the sort non-deterministic for exact ties.
  const nowMs = useMemo(() => Date.now(), [shops]);

  // NO SEND WINDOW. There used to be a "Unlocks Mon 20:00 · now Mon 12:00" pill
  // beside the button, advertising a weekly cadence it never actually enforced.
  // It was removed on 2026-09-14 because it was the worst of both: it could not
  // stop anyone running the campaign at any hour, and it told the operator their
  // own judgement was subordinate to a clock that did nothing. Whoever is
  // watching the inbox decides when to spend the money; the confirmation panel
  // states what the run costs, which is the fact that actually informs that
  // decision. lib/reachout/sendWindowGate.ts went with it.
  //
  // (The 09:00-20:00 Europe/Madrid window in lib/sequences/sendWindow.ts is a
  // different thing and still applies: it governs when individual touches SEND,
  // so a scrape started at midnight does not mail florists at 03:00.)

  // Joined shops are counted, not ranked. Excluding them BEFORE ranking is what
  // makes the visible list start at #1 — rank them and filter afterwards and the
  // table opens at #9, which reads as a page-2 of a list nobody saw page 1 of.
  const joinedCount = useMemo(() => shops.filter((s) => s.joinedAt).length, [shops]);

  const ranked = useMemo(
    () => collapseDuplicates(rankShops(shops.filter((s) => !s.joinedAt), nowMs)),
    [shops, nowMs]
  );

  const counts = useMemo(() => {
    const c = new Map<ReachOutTier, number>();
    for (const s of ranked) c.set(s.tier, (c.get(s.tier) ?? 0) + 1);
    return c;
  }, [ranked]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = ranked.filter((s) => {
      if (onlyCallable && !CALLABLE.includes(s.tier)) return false;
      if (!q) return true;
      return [s.name, s.city, s.email, s.phone].some((v) => v?.toLowerCase().includes(q));
    });
    if (sort === "rank") return filtered;
    // Secondary sorts never reorder across tiers — the tier IS the ranking, and
    // letting "sort by name" mix a bounced shop in among the clickers would
    // quietly undo the one thing this page is for.
    return [...filtered].sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      switch (sort) {
        case "name": return (a.name ?? "").localeCompare(b.name ?? "");
        case "city": return (a.city ?? "").localeCompare(b.city ?? "");
        case "touches": return (b.touchesSent ?? 0) - (a.touchesSent ?? 0);
        case "signal": {
          // Nulls last regardless of direction, mirroring FloristTable.
          const at = a.lastSignalAt ? Date.parse(a.lastSignalAt) : -Infinity;
          const bt = b.lastSignalAt ? Date.parse(b.lastSignalAt) : -Infinity;
          return bt - at;
        }
        default: return a.rank - b.rank;
      }
    });
  }, [ranked, onlyCallable, search, sort]);

  if (failed) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-ink">Reach Out</h1>
        <div className="mt-4">
          <ErrorState
            title="The call list is unavailable"
            description="This is a query failure, not an empty list — do not read it as “nobody to call”."
          />
        </div>
      </div>
    );
  }

  const scopedElsewhere =
    settings.autoEnrolScraped &&
    settings.autoEnrolCountries !== null &&
    settings.autoEnrolCountries.length > 0 &&
    !settings.autoEnrolCountries.some((c) => c.trim().toLowerCase() === country.toLowerCase());

  return (
    <div className="p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold text-ink">Reach Out</h1>
            <button
              type="button"
              onClick={() => setSendConfirm(true)}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition hover:bg-accent-ink active:scale-[0.98]"
            >
              Send {CITY_COUNT} cities today
            </button>
          </div>
          <p className="mt-1 text-sm text-ink-soft">
            Every florist we have found in {country}, ordered by how close they are to joining.
            Call the top of the list.
          </p>
        </div>
      </header>

      {sendConfirm && (
        <div className="mt-4 rounded-md border border-accent bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] px-4 py-3 text-sm">
          <p className="font-medium text-ink">Send the {CITY_COUNT}-city scrape?</p>
          <p className="mt-1 text-ink-soft">
            {CITY_COUNT} cities, covered by <strong>{SCRAPE_JOBS} runs</strong> —
            the rest sit inside a neighbour&apos;s circle, and scraping them
            separately would file the same shop under two cities. At{" "}
            {PLACES_PER_CITY} places each that is roughly{" "}
            <strong>
              {RUN_PLACES.toLocaleString()} places ≈ ${RUN_COST_USD.toFixed(2)}
            </strong>{" "}
            on Apify, well inside the $19 monthly ceiling. Cities already scraped
            are skipped — ingest upserts on <code>(city_id, place_id)</code>, so
            nothing is duplicated or re-paid for.
          </p>
          {result === null ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={sending !== null}
                onClick={() => runScrape()}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition hover:bg-accent-ink active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-line-strong"
              >
                {sending === "full" ? "Starting…" : `Start all ${SCRAPE_JOBS} runs · $${RUN_COST_USD.toFixed(2)}`}
              </button>
              <button
                type="button"
                disabled={sending !== null}
                onClick={() => runScrape(1)}
                className="rounded-md border border-line-strong px-3 py-1.5 text-sm font-medium transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {sending === "test" ? "Starting…" : `Just ${TEST_CITY} · $${TEST_COST_USD.toFixed(2)}`}
              </button>
              <button
                type="button"
                disabled={sending !== null}
                onClick={() => setSendConfirm(false)}
                className="rounded-md px-3 py-1.5 text-sm text-ink-soft hover:bg-surface-2 disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="mt-3 text-ink-soft">
              <p>
                <strong className="text-ink">{result.enqueued} queued</strong>
                {result.skipped > 0 && <> · {result.skipped} skipped (already running or done)</>}
              </p>
              {result.errors.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-[var(--crit)]">
                  {result.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              )}
              <p className="mt-2">
                Scraping runs on the worker cron, up to 8 cities at once.{" "}
                <Link href="/jobs" className="text-accent underline">
                  Watch it on /jobs
                </Link>
                . Shops with an email are enrolled automatically and receive the
                first email within a minute — provided the funnel and auto-enrol
                are both on in Settings.
              </p>
              <button
                type="button"
                onClick={() => {
                  setResult(null);
                  setSendConfirm(false);
                }}
                className="mt-2 rounded-md border border-line-strong px-3 py-1 text-sm hover:bg-surface-2"
              >
                Close
              </button>
            </div>
          )}
        </div>
      )}

      {/* What the funnel is actually allowed to do. A busy-looking call list
          while nothing is sending is the most misleading state this page has. */}
      <div className="mt-4 space-y-2">
        {!settings.sequenceEnabled && (
          <Banner tone="warn">
            <strong>The funnel is switched off.</strong> Nothing is being sent to any of these
            shops — <code>sequence_enabled</code> is false. The list below is history, not a
            campaign in flight.
          </Banner>
        )}
        {settings.sequenceEnabled && settings.minGapHours !== null && settings.minGapHours > 3 && (
          <Banner tone="crit">
            <strong>Follow-ups are being suppressed.</strong> The same-day funnel sends its
            second touch 3.5 h after the first, but <code>sequence_min_gap_hours</code> is{" "}
            {settings.minGapHours} — every follow-up is deferred past its own step, so shops
            get one email and nothing else.
          </Banner>
        )}
        {scopedElsewhere && (
          <Banner tone="warn">
            <strong>Auto-enrol is scoped to another market.</strong>{" "}
            <code>sequence_auto_enrol_countries</code> is{" "}
            {settings.autoEnrolCountries?.join(", ")} — newly scraped {country} shops are not
            being enrolled.
          </Banner>
        )}
      </div>

      {/* The scoreboard. A number, not a list — anyone wanting the detail has
          /florists with its `production` stage filter, and repeating it here
          would duplicate a screen that already exists. */}
      <div className="mt-5 flex items-center gap-4 rounded-lg border border-[var(--good)] bg-[color-mix(in_srgb,var(--good)_8%,transparent)] px-5 py-4">
        <IconCheckCircle className="h-6 w-6 shrink-0 text-[var(--good)]" />
        <div>
          <div className="text-sm font-medium text-ink-soft">Florists that joined</div>
          <div className="text-3xl font-semibold tabular-nums text-ink">{joinedCount}</div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Clicked, not joined" value={counts.get(1) ?? 0} accent="amber" icon={<IconStar className="h-4 w-4" />} />
        <StatTile label="Opened only" value={counts.get(2) ?? 0} accent="indigo" icon={<IconMail className="h-4 w-4" />} />
        <StatTile label="Not yet engaged" value={(counts.get(3) ?? 0) + (counts.get(4) ?? 0) + (counts.get(5) ?? 0)} accent="slate" icon={<IconPhone className="h-4 w-4" />} />
        <StatTile label="Bounced / opted out" value={counts.get(6) ?? 0} accent="red" icon={<IconXCircle className="h-4 w-4" />} />
      </div>

      <div className="filterbar mt-5 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={onlyCallable}
            onChange={(e) => setOnlyCallable(e.target.checked)}
            className="h-4 w-4"
          />
          Worth calling only
        </label>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Shop, city, email or phone"
          className="min-w-56 flex-1 rounded-md border border-line-strong px-3 py-1.5 text-sm shadow-sm focus:border-accent focus:outline-none"
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortColumn)}
          className="rounded-md border border-line-strong px-3 py-1.5 text-sm shadow-sm"
          aria-label="Sort within tier"
        >
          <option value="rank">Rank</option>
          <option value="signal">Most recent signal</option>
          <option value="name">Shop name</option>
          <option value="city">City</option>
          <option value="touches">Emails sent</option>
        </select>
        <span className="text-sm text-ink-soft tabular-nums">{rows.length} shown</span>
      </div>

      {rows.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={<IconPhone className="h-6 w-6" />}
            title={onlyCallable ? "Nobody has engaged yet" : "No shops match"}
            description={
              onlyCallable
                ? "No shop in this market has opened or clicked without joining. Untick “Worth calling only” to see everyone we have found."
                : "Try a different search."
            }
          />
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[60rem] border-collapse text-sm">
            <thead>
              <tr>
                <Th label="#" align="right" />
                <Th label="Shop" />
                <Th label="City" />
                <Th label="Stage" />
                <Th label="Opens" align="right" />
                <Th label="Clicks" align="right" />
                <Th label="Last signal" align="right" />
                <Th label="Emails sent" align="right" />
                <Th label="Phone" />
                <Th label="Email" />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <Row key={s.floristId} shop={s} nowMs={nowMs} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Banner({ tone, children }: { tone: "warn" | "crit"; children: React.ReactNode }) {
  const cls =
    tone === "crit"
      ? "border-[var(--crit)] bg-[color-mix(in_srgb,var(--crit)_8%,transparent)]"
      : "border-[var(--warn)] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)]";
  return <div className={`rounded-md border px-3 py-2 text-sm text-ink ${cls}`}>{children}</div>;
}

function Th({ label, align = "left" }: { label: string; align?: "left" | "right" }) {
  return (
    <th
      scope="col"
      className={`sticky top-0 bg-surface-2 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-soft ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {label}
    </th>
  );
}

function Row({ shop, nowMs }: { shop: RankedShop; nowMs: number }) {
  // The score's terms, for the title attribute. CS does not need the arithmetic
  // on screen, but "why is this one above that one" has to be answerable
  // without reading the source — see rankBreakdown's doc comment.
  const why = Object.entries(shop.breakdown)
    .filter(([, v]) => Math.abs(v) > 0.001)
    .map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v.toFixed(2)}`)
    .join("  ");

  return (
    <tr className="border-t border-line hover:bg-surface-2">
      <td className="px-3 py-2 text-right tabular-nums text-ink-soft" title={`score ${shop.score.toFixed(2)}${why ? ` — ${why}` : ""}`}>
        {shop.rank}
      </td>
      <td className="px-3 py-2">
        {/* The florist page IS the contact surface — it already carries notes,
            "log meeting", the outreach panel and the full history. A separate
            "Contact florist" button would be a second door to the same room. */}
        <Link href={`/florists/${shop.floristId}`} className="font-medium text-accent hover:underline">
          {shop.name ?? "Unnamed shop"}
        </Link>
      </td>
      <td className="px-3 py-2 text-ink-soft">{shop.city ?? "—"}</td>
      <td className="px-3 py-2"><TierPill tier={shop.tier} /></td>
      <td className="px-3 py-2 text-right tabular-nums">{shop.openCount ?? 0}</td>
      <td className="px-3 py-2 text-right tabular-nums">{shop.clickCount ?? 0}</td>
      <td className="px-3 py-2 text-right tabular-nums text-ink-soft">{ago(shop.lastSignalAt, nowMs)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-ink-soft">{shop.touchesSent ?? 0}</td>
      <td className="px-3 py-2 whitespace-nowrap">
        {shop.phone ? (
          <a href={`tel:${shop.phone}`} className="inline-flex items-center gap-1 text-accent hover:underline">
            <IconPhone className="h-3.5 w-3.5" />
            {shop.phone}
          </a>
        ) : (
          <span className="text-ink-soft">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-ink-soft">{shop.email ?? "—"}</td>
    </tr>
  );
}
