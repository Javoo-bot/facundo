"use client";
import { StatTile, ChartCard, ChartEmpty } from "./ChartPrimitives";
import type { FulfilmentStats } from "@/lib/opsStats";

export default function FulfilmentSection({ data }: { data: FulfilmentStats }) {
  // Bucketing (0-48h in 6h buckets, last bucket catches the rest) now happens
  // in SQL (get_fulfilment_stats) over the full matching set, not just
  // whatever rows PostgREST handed back — see lib/opsStats.ts.
  const rows = data.timeToDeliveryHistogram;
  const maxCount = Math.max(1, ...rows.map((r) => r.count));
  const totalCount = rows.reduce((sum, r) => sum + r.count, 0);
  return (
    <section style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        <StatTile label="Delivered" value={String(data.deliveredCount)} sublabel={`of ${data.acceptedCount} accepted`} />
        <StatTile label="Completion rate" value={data.completionRate != null ? `${(data.completionRate * 100).toFixed(0)}%` : "—"} />
        <StatTile label="On-time rate" value={data.onTimeRate != null ? `${(data.onTimeRate * 100).toFixed(0)}%` : "—"} sublabel={`${data.onTimeCount} on time`} />
      </div>
      <ChartCard title="Time to delivery">
        {totalCount === 0 ? (
          <ChartEmpty label="No deliveries in this range." />
        ) : (
          <div style={{ display: "flex", gap: 4, alignItems: "flex-end", height: 120 }}>
            {rows.map((r) => (
              <div key={r.bucket} style={{ flex: 1, display: "grid", gap: 4, justifyItems: "center" }}>
                <div
                  style={{ width: "100%", background: "var(--accent)", borderRadius: "3px 3px 0 0", height: Math.max(2, (r.count / maxCount) * 96) }}
                  role="img"
                  aria-label={`${r.bucket}: ${r.count} deliveries`}
                  title={`${r.bucket}: ${r.count}`}
                />
                <span style={{ fontSize: ".65rem", color: "var(--ink-faint)" }}>{r.bucket}</span>
              </div>
            ))}
          </div>
        )}
      </ChartCard>
    </section>
  );
}
