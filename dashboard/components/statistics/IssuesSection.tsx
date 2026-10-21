"use client";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { StatTile, ChartCard, ChartEmpty, CHART_COLORS } from "./ChartPrimitives";
import type { IssuesStats } from "@/lib/opsStats";

export default function IssuesSection({ data }: { data: IssuesStats }) {
  const rows = Object.entries(data.byType).map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
  return (
    <section style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        <StatTile label="Total issues" value={String(data.totalIssues)} />
        <StatTile label="Open" value={String(data.openCount)} />
        <StatTile label="Resolved" value={String(data.resolvedCount)} />
      </div>
      <ChartCard title="Issues by type">
        {rows.length === 0 ? (
          <ChartEmpty label="No issues in this range." />
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(120, rows.length * 34)}>
            <BarChart data={rows} layout="vertical">
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: "var(--ink-faint)" }} stroke="var(--line)" />
              <YAxis type="category" dataKey="type" width={160} tick={{ fontSize: 11, fill: "var(--ink-faint)" }} stroke="var(--line)" />
              <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12, color: "var(--ink)" }} />
              <Bar dataKey="count" name="Issues" fill={CHART_COLORS[3]} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </section>
  );
}
