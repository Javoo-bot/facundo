"use client";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { StatTile, ChartCard, ChartEmpty, CHART_COLORS } from "./ChartPrimitives";
import type { UsageStats } from "@/lib/opsStats";

export default function UsageSection({ data }: { data: UsageStats }) {
  return (
    <section style={{ display: "grid", gap: 12 }}>
      <StatTile
        label="Median offer response time"
        value={data.medianResponseMinutes != null ? `${data.medianResponseMinutes.toFixed(0)} min` : "—"}
      />
      <ChartCard title="Active florists per day">
        {data.activeFloristsByDay.length === 0 ? (
          <ChartEmpty label="No florist sign-ins in this range." />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={data.activeFloristsByDay}>
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--ink-faint)" }} stroke="var(--line)" />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--ink-faint)" }} stroke="var(--line)" />
              <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12, color: "var(--ink)" }} />
              <Line type="monotone" dataKey="count" name="Active florists" stroke={CHART_COLORS[0]} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </section>
  );
}
