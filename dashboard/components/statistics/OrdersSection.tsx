"use client";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { StatTile, ChartCard, ChartEmpty, CHART_COLORS } from "./ChartPrimitives";
import type { OrdersStats } from "@/lib/opsStats";

export default function OrdersSection({ data }: { data: OrdersStats }) {
  const statusEntries = Object.entries(data.byStatus);
  return (
    <section style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        <StatTile label="Total orders" value={String(data.totalOrders)} />
        {statusEntries.map(([status, count]) => (
          <StatTile key={status} label={status} value={String(count)} />
        ))}
      </div>
      <ChartCard title="Orders per day">
        {data.byDay.length === 0 ? (
          <ChartEmpty />
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data.byDay}>
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--ink-faint)" }} stroke="var(--line)" />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--ink-faint)" }} stroke="var(--line)" />
              <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12, color: "var(--ink)" }} />
              <Bar dataKey="count" name="Orders" fill={CHART_COLORS[0]} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </section>
  );
}
