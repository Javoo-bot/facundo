"use client";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { StatTile, ChartCard, ChartEmpty, CHART_COLORS } from "./ChartPrimitives";
import type { AcceptanceStats } from "@/lib/opsStats";

function toChartRows(reasons: Record<string, number>): { reason: string; count: number }[] {
  return Object.entries(reasons).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

export default function AcceptanceSection({ data }: { data: AcceptanceStats }) {
  const declineRows = toChartRows(data.declineReasons);
  const releaseRows = toChartRows(data.releaseReasons);
  return (
    <section style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        <StatTile label="Assignments" value={String(data.totalAssignments)} />
        <StatTile label="Accepted" value={String(data.acceptedCount)} />
        <StatTile label="Accept rate" value={data.acceptRate != null ? `${(data.acceptRate * 100).toFixed(0)}%` : "—"} />
      </div>
      <ChartCard title="Decline reasons (pre-accept)">
        {declineRows.length === 0 ? (
          <ChartEmpty label="No declines in this range." />
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(120, declineRows.length * 34)}>
            <BarChart data={declineRows} layout="vertical">
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: "var(--ink-faint)" }} stroke="var(--line)" />
              <YAxis type="category" dataKey="reason" width={140} tick={{ fontSize: 11, fill: "var(--ink-faint)" }} stroke="var(--line)" />
              <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12, color: "var(--ink)" }} />
              <Bar dataKey="count" name="Declines" fill={CHART_COLORS[1]} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
      <ChartCard title="Release reasons (post-accept)">
        {releaseRows.length === 0 ? (
          <ChartEmpty label="No releases in this range." />
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(120, releaseRows.length * 34)}>
            <BarChart data={releaseRows} layout="vertical">
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: "var(--ink-faint)" }} stroke="var(--line)" />
              <YAxis type="category" dataKey="reason" width={140} tick={{ fontSize: 11, fill: "var(--ink-faint)" }} stroke="var(--line)" />
              <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12, color: "var(--ink)" }} />
              <Bar dataKey="count" name="Releases" fill={CHART_COLORS[2]} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </section>
  );
}
