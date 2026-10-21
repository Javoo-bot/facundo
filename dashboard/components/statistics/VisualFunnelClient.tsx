"use client";
import { useCallback } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import DateRangePicker from "./DateRangePicker";
import FunnelCascade from "./FunnelCascade";
import { ChartEmpty } from "./ChartPrimitives";
import type { StatsRange } from "@/lib/opsStats";
import { overallConversion, formatPct, type VisualFunnelStats } from "@/lib/visualFunnel";
import { pageTitle } from "@/lib/brand";

// One panel, one control, one question.
//
// This screen is deliberately the least furnished in the backoffice. It answers
// exactly one question — which step is losing florists — and every element that
// does not help answer it was removed rather than shrunk: the four stat tiles
// (the first and last step of the funnel ARE "picked" and "signed up", and the
// end-to-end rate is one division), the five-paragraph "how to read this" card,
// and the separate verdict banner.
//
// The date control is the exception that came BACK (2026-09-04): it used to be
// `presetsOnly` — three fixed windows, no custom range — on the reasoning that
// picking dates was a power move belonging on the General tab. But "how did the
// funnel do on the day we ran the Girona push" is the question people actually
// bring here, and no fixed window could express it. The picker is now the same
// full Today / Yesterday / Custom control both statistics views share.
//
// The closing prose went too, at the owner's call (2026-09-02): a verdict
// sentence, a "still mid-sequence" note and a "no delivery feedback" note under
// a chart that already draws all three. The chart keeps carrying them — the
// worst transition is the red arrow, and a step nothing reached is an empty
// ring reading 0 — so the facts are on screen; only the sentences about them
// are gone. lib/visualFunnel.ts still exports biggestDrop/trackingBlind, which
// is what FunnelCascade colours the worst arrow from, so restoring a line of
// text later is a two-line change and no new query.

/** Same rule as StatisticsClient's SectionUnavailable: a backend failure says
 * "we couldn't ask", never "zero". A funnel of zeroes is the single most
 * misreadable thing this page could draw. */
function FunnelUnavailable() {
  return (
    <div className="card" style={{ padding: 16, color: "var(--ink-faint)", fontSize: ".85rem" }}>
      <strong style={{ color: "var(--ink-soft)" }}>The funnel</strong> is unavailable — its data couldn&rsquo;t be
      loaded, so nothing is shown rather than a misleading zero. Check the server log for the reason (a migration
      that hasn&rsquo;t been applied is the usual one).
    </div>
  );
}

export default function VisualFunnelClient({
  range,
  data,
  activeDays,
}: {
  range: StatsRange;
  data: VisualFunnelStats | null;
  activeDays: string[] | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Identical to StatisticsClient: patch the URL, router.replace, let the
  // force-dynamic server component re-run with the new range.
  const handleRangeChange = useCallback(
    (next: StatsRange) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("from", next.from);
      params.set("to", next.to);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  return (
    <div className="ds page" style={{ maxWidth: "var(--maxw-wide)", margin: "0 auto", padding: "24px 20px 60px", display: "grid", gap: 20 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <p className="eyebrow">Backoffice</p>
          <h1 style={{ fontSize: "1.4rem", fontWeight: 650, color: "var(--ink)" }}>{pageTitle("Statistics & Insights")}</h1>
        </div>
        <DateRangePicker value={range} onChange={handleRangeChange} activeDays={activeDays} />
      </div>

      {!data ? <FunnelUnavailable /> : <FunnelPanel stats={data} />}
    </div>
  );
}

function FunnelPanel({ stats }: { stats: VisualFunnelStats }) {
  const conversion = overallConversion(stats);

  return (
    <div className="card" style={{ padding: "22px 20px 20px", display: "grid", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: "1.05rem", fontWeight: 650, color: "var(--ink)" }}>Where we lose florists</h2>
        {stats.picked > 0 && (
          <span style={{ font: "500 .78rem/1 var(--mono)", color: "var(--ink-faint)", fontVariantNumeric: "tabular-nums" }}>
            {formatPct(conversion)} picked → signed up
          </span>
        )}
      </div>

      {stats.picked === 0 ? (
        <ChartEmpty label="No shops entered the recruiting funnel in this period." />
      ) : (
        <FunnelCascade stats={stats} />
      )}
    </div>
  );
}
