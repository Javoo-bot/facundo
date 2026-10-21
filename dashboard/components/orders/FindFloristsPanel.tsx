"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Button from "@/components/ui/Button";
import Badge from "@/components/ui/Badge";

// "Find florists" — adjust the matching knobs for THIS order, see the ranking
// they produce, then commit the candidates.
//
// The preview and the commit call the same ranking code (lib/rematch.ts) with
// the same config, so the list below is not an approximation of what pressing
// Add will do — it is the same computation. Overrides apply to this run only;
// the saved settings (Settings → Matching) are never written from here.

interface PreviewCandidate {
  floristId: string;
  name: string | null;
  rank: number;
  ring: number;
  distanceKm: number | null;
  score: number;
  breakdown: Record<string, number>;
  source: string | null;
  alreadyAssigned: boolean;
}

interface Area {
  country: string;
  city: string;
  radiusKm: number;
}

interface AreaJob {
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  floristCount: number | null;
  radiusKm: number | null;
  lastLine: string | null;
}

interface Overrides {
  ringEdgesKm: number[];
  topN: number;
  requireTrustTier: boolean;
  excludeTier4: boolean;
  allowUnrated: boolean;
  minRating: number | null;
  minReviewCount: number | null;
}

/** "3 weeks ago" / "just now". Local to this panel — the shared formatRelative
 *  in components/orders/format.ts is built around order timestamps and returns
 *  a different shape. */
function relative(iso: string | null): string {
  if (!iso) return "at some point";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "at some point";
  const mins = Math.round(ms / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${weeks} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

const TERM_LABEL: Record<string, string> = {
  distance: "distance", onboarded: "onboarded", emailable: "email",
  quality: "rating", source: "relationship", tier: "tier", performance: "record",
};

/** Preset ring ladders — ascending km edges, last edge is the hard cap (same
 *  rule the free-text field enforced). A saved/custom ladder that doesn't
 *  match one of these is kept as its own option so switching to a dropdown
 *  never silently changes the config — see ringSelectValue below. */
const RING_PRESETS: number[][] = [
  [5, 10, 20],
  [5, 15, 30],
  [10, 25, 50],
  [20, 50, 100],
];
const ringPresetKey = (edges: number[]) => edges.join(",");
const ringPresetLabel = (edges: number[]) => edges.join("/");

/** Preset "candidates to add" counts — 1-10 plus a few coarser jumps. */
const TOP_N_PRESETS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25] as const;

/** Preset rating/review floors. `null` = "no floor". */
const MIN_RATING_PRESETS = [3.5, 4.0, 4.2, 4.5, 4.8] as const;
const MIN_REVIEW_PRESETS = [5, 10, 25, 50, 100] as const;

export default function FindFloristsPanel({ orderId, label }: { orderId: string; label: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<PreviewCandidate[]>([]);
  const [wouldAdd, setWouldAdd] = useState<string[]>([]);
  const [considered, setConsidered] = useState(0);
  const [ov, setOv] = useState<Overrides | null>(null);
  const [area, setArea] = useState<Area | null>(null);
  const [areaJob, setAreaJob] = useState<AreaJob | null>(null);
  const [ingesting, setIngesting] = useState(false);
  const [ingestNote, setIngestNote] = useState<string | null>(null);

  const runPreview = useCallback(async (override: Overrides | null) => {
    setLoading(true); setErr(null); setNote(null);
    try {
      const res = await fetch("/api/orders/rematch/preview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, config: override ?? undefined }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j.error ?? "Could not rank florists."); setCandidates([]); return; }
      setCandidates(j.candidates ?? []);
      setArea(j.area ?? null);
      setAreaJob(j.areaJob ?? null);
      setWouldAdd(j.wouldAdd ?? []);
      setConsidered(j.consideredCount ?? 0);
      // Seed the controls from the saved config the first time only, so
      // picks aren't clobbered by each refresh.
      setOv((prev) => {
        if (prev) return prev;
        const c = j.config ?? {};
        return {
          ringEdgesKm: c.ringEdgesKm ?? [5, 10, 20],
          topN: c.topN ?? 3,
          requireTrustTier: c.requireTrustTier ?? true,
          excludeTier4: c.excludeTier4 ?? false,
          allowUnrated: c.allowUnrated ?? true,
          minRating: c.minRating ?? null,
          minReviewCount: c.minReviewCount ?? null,
        };
      });
    } catch { setErr("Network error — please retry."); }
    finally { setLoading(false); }
  }, [orderId]);

  useEffect(() => { if (open) void runPreview(null); }, [open, runPreview]);

  function patch<K extends keyof Overrides>(key: K, value: Overrides[K]) {
    setOv((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  // Scrape this delivery area. `force` is only offered once we've already
  // scraped it — the server refuses a plain re-request in that case, and the
  // operator should have to say "yes, look again" rather than click a button
  // that silently no-ops.
  async function startIngest(force: boolean) {
    setIngesting(true); setIngestNote(null); setErr(null);
    try {
      const res = await fetch("/api/orders/ingest-area", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, force }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j.error ?? "Could not queue the ingest."); return; }
      setAreaJob(j.job ?? null);
      // "error" is its own outcome on purpose — it used to arrive as
      // "already-running", which told the reader nothing had gone wrong.
      if (j.outcome === "error") {
        setErr("Couldn't queue the scrape — the request failed. Nothing was started; check the Jobs page and the error log.");
        setIngestNote(null);
        return;
      }
      setIngestNote(
        j.outcome === "queued"
          ? `Queued — scraping ${j.area.city}, ${j.area.country} within ${j.area.radiusKm}km. It runs in the background; watch it on the Jobs page.`
          : j.outcome === "already-running"
          ? "An ingest for this area is already queued or running — nothing new started."
          : j.outcome === "already-ingested"
          ? "We've already scraped this area. Use “Scrape again” if you want a fresh look."
          : "Nothing was queued."
      );
    } catch { setErr("Network error — please retry."); }
    finally { setIngesting(false); }
  }

  async function commit() {
    setCommitting(true); setErr(null);
    try {
      const res = await fetch("/api/orders/rematch", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, config: ov ?? undefined }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j.error ?? "Could not add candidates."); return; }
      if (!j.added) { setNote(j.note ?? "Nothing to add."); return; }
      setOpen(false);
      router.refresh();
    } catch { setErr("Network error — please retry."); }
    finally { setCommitting(false); }
  }

  if (!open) {
    return <Button variant="default" onClick={() => setOpen(true)}>{label}</Button>;
  }

  const cap = ov?.ringEdgesKm[ov.ringEdgesKm.length - 1];
  const fresh = candidates.filter((c) => !c.alreadyAssigned);

  return (
    <div className="w-full rounded-lg border border-line bg-surface p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">Find florists</h3>
        <button className="text-sm text-ink-faint hover:text-ink" onClick={() => setOpen(false)}>Close</button>
      </div>
      <p className="mt-1 text-xs text-ink-faint">
        Changes here apply to this order only — the saved matching settings are untouched.
      </p>

      {/* Controls */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-ink-soft">
          Ring edges (km)
          <select
            className="mt-1 w-full rounded-md border border-line-strong px-2 py-1 text-sm"
            aria-label="Ring edges, in kilometers"
            value={ringPresetKey(ov?.ringEdgesKm ?? [5, 10, 20])}
            onChange={(e) => {
              const edges = e.target.value.split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
              if (edges.length) patch("ringEdgesKm", edges);
            }}
          >
            {RING_PRESETS.map((p) => (
              <option key={ringPresetKey(p)} value={ringPresetKey(p)}>
                {ringPresetLabel(p)}
              </option>
            ))}
            {ov && !RING_PRESETS.some((p) => ringPresetKey(p) === ringPresetKey(ov.ringEdgesKm)) && (
              <option value={ringPresetKey(ov.ringEdgesKm)}>
                {ringPresetLabel(ov.ringEdgesKm)} (current, custom)
              </option>
            )}
          </select>
          <span className="mt-1 block text-xs text-ink-faint">
            Nearer ring always wins. The last edge is the hard cap.
          </span>
        </label>

        <label className="text-sm text-ink-soft">
          Candidates to add
          <select
            className="mt-1 w-full rounded-md border border-line-strong px-2 py-1 text-sm"
            aria-label="Number of candidates to add"
            value={String(ov?.topN ?? 3)}
            onChange={(e) => patch("topN", Math.max(1, Math.min(25, Number(e.target.value) || 1)))}
          >
            {TOP_N_PRESETS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            {ov && !(TOP_N_PRESETS as readonly number[]).includes(ov.topN) && (
              <option value={ov.topN}>{ov.topN} (current, custom)</option>
            )}
          </select>
        </label>

        <label className="text-sm text-ink-soft">
          Minimum rating
          <select
            className="mt-1 w-full rounded-md border border-line-strong px-2 py-1 text-sm"
            aria-label="Minimum rating"
            value={ov?.minRating == null ? "" : String(ov.minRating)}
            onChange={(e) => patch("minRating", e.target.value === "" ? null : Number(e.target.value))}
          >
            <option value="">No floor</option>
            {MIN_RATING_PRESETS.map((r) => (
              <option key={r} value={r}>
                {r.toFixed(1)}+
              </option>
            ))}
            {ov?.minRating != null && !(MIN_RATING_PRESETS as readonly number[]).includes(ov.minRating) && (
              <option value={ov.minRating}>{ov.minRating}+ (current, custom)</option>
            )}
          </select>
        </label>

        <label className="text-sm text-ink-soft">
          Minimum reviews
          <select
            className="mt-1 w-full rounded-md border border-line-strong px-2 py-1 text-sm"
            aria-label="Minimum review count"
            value={ov?.minReviewCount == null ? "" : String(ov.minReviewCount)}
            onChange={(e) => patch("minReviewCount", e.target.value === "" ? null : Number(e.target.value))}
          >
            <option value="">No floor</option>
            {MIN_REVIEW_PRESETS.map((n) => (
              <option key={n} value={n}>
                {n}+
              </option>
            ))}
            {ov?.minReviewCount != null && !(MIN_REVIEW_PRESETS as readonly number[]).includes(ov.minReviewCount) && (
              <option value={ov.minReviewCount}>{ov.minReviewCount}+ (current, custom)</option>
            )}
          </select>
        </label>
      </div>

      <div className="mt-3 space-y-2">
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={ov?.allowUnrated ?? true} onChange={(e) => patch("allowUnrated", e.target.checked)} />
          Allow unrated florists
        </label>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={ov?.excludeTier4 ?? false} onChange={(e) => patch("excludeTier4", e.target.checked)} />
          Never offer to trust tier 4
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={ov?.requireTrustTier ?? true} onChange={(e) => patch("requireTrustTier", e.target.checked)} />
          <span style={{ color: ov?.requireTrustTier ? "var(--ink)" : "var(--crit)" }}>
            Require a trust tier
          </span>
        </label>
        {ov && !ov.requireTrustTier && (
          <p className="text-xs" style={{ color: "var(--crit)" }}>
            Off — this can offer the order to florists with no payout split configured. They can
            accept and deliver, but paying them will fail. Use for recruiting runs only.
          </p>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button variant="default" disabled={loading} onClick={() => void runPreview(ov)}>
          {loading ? "Ranking…" : "Preview"}
        </Button>
        <Button variant="solid" disabled={committing || loading || fresh.length === 0} onClick={() => void commit()}>
          {committing ? "Adding…" : `Add ${Math.min(wouldAdd.length, ov?.topN ?? 3)} candidate(s)`}
        </Button>
      </div>

      {err && <p className="mt-3 text-sm" style={{ color: "var(--crit)" }}>{err}</p>}
      {note && <p className="mt-3 text-sm text-ink-faint">{note}</p>}

      {/* Results */}
      <div className="mt-4">
        <p className="text-xs text-ink-faint">
          {considered} florist{considered === 1 ? "" : "s"} within {cap ?? "—"}km of the delivery
          address · {candidates.length} passed the filters
          {fresh.length !== candidates.length && ` · ${candidates.length - fresh.length} already on this order`}
        </p>
        {candidates.length === 0 && !loading && (
          <p className="mt-2 text-sm text-ink-faint">
            Nobody matched. Widen the last ring edge, lower the quality floor — or scrape this area below.
          </p>
        )}

        {/* COVERAGE. Shown whenever we know where this order goes, and given a
            highlighted border when nothing was in range — a coverage gap is the
            answer in that case, not a wider ring. */}
        {area && (
          <div
            className="mt-4 rounded-md border p-3"
            style={{ borderColor: considered === 0 ? "var(--warn)" : "var(--line)" }}
          >
            <p className="text-sm font-medium text-ink">
              Coverage · {area.city}, {area.country}
            </p>
            <p className="mt-0.5 text-xs text-ink-faint">
              {!areaJob
                ? "We have never scraped this area — that is why nobody is in range."
                : areaJob.status === "queued" || areaJob.status === "running"
                ? `An ingest is ${areaJob.status} now${areaJob.lastLine ? ` — ${areaJob.lastLine}` : ""}.`
                : areaJob.status === "succeeded"
                ? `Scraped ${relative(areaJob.finishedAt ?? areaJob.startedAt)} within ${areaJob.radiusKm ?? "?"}km` +
                  (areaJob.floristCount != null ? `, found ${areaJob.floristCount} florist${areaJob.floristCount === 1 ? "" : "s"}.` : ".")
                : `The last ingest failed ${relative(areaJob.finishedAt ?? areaJob.startedAt)}.`}
            </p>
            <div className="mt-2 flex items-center gap-2">
              {areaJob?.status === "queued" || areaJob?.status === "running" ? (
                <span className="text-xs text-ink-faint">Nothing to start — it is already running.</span>
              ) : (
                <Button
                  variant={considered === 0 ? "solid" : "default"}
                  disabled={ingesting}
                  onClick={() => void startIngest(areaJob?.status === "succeeded")}
                >
                  {ingesting
                    ? "Queueing…"
                    : areaJob?.status === "succeeded"
                    ? `Scrape ${area.city} again`
                    : `Scrape ${area.city} (${area.radiusKm}km)`}
                </Button>
              )}
              <Link href="/jobs" className="text-xs text-ink-faint underline hover:text-ink">Jobs</Link>
            </div>
            <p className="mt-2 text-xs text-ink-faint">
              Runs in the background — it does not hold this order up, and costs Apify + Claude credits.
              Scraping as wide as we match ({area.radiusKm}km) usually pulls in nearby towns too.
            </p>
            {ingestNote && <p className="mt-2 text-xs text-ink">{ingestNote}</p>}
          </div>
        )}
        <ul className="mt-2 divide-y divide-line">
          {candidates.slice(0, 25).map((c, i) => {
            const willAdd = wouldAdd.includes(c.floristId);
            return (
              <li key={c.floristId} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-ink">{c.name ?? c.floristId.slice(0, 8)}</span>
                    <Badge info={{ cls: "badge-neutral", label: `ring ${c.ring + 1}` }} />
                    {c.alreadyAssigned && <Badge info={{ cls: "badge-neutral", label: "already on order" }} />}
                    {willAdd && <Badge info={{ cls: "badge-accent", label: "will add" }} />}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-faint">
                    {c.distanceKm != null ? `${c.distanceKm.toFixed(1)}km` : "—"} · score {c.score.toFixed(2)}
                    {" · "}
                    {/* Biggest contributors first — what actually decided this row's place. */}
                    {Object.entries(c.breakdown)
                      .filter(([, v]) => Math.abs(v) > 0.001)
                      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
                      .slice(0, 4)
                      .map(([k, v]) => `${TERM_LABEL[k] ?? k} ${v > 0 ? "+" : ""}${v.toFixed(2)}`)
                      .join(", ")}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-ink-faint">#{i + 1}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
