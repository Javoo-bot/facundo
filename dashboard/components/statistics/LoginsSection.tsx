"use client";
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { ChartCard, ChartEmpty, CHART_COLORS } from "./ChartPrimitives";
import type { LoginStats } from "@/lib/opsStats";

function merge(staff: { date: string; count: number }[], florist: { date: string; count: number }[]) {
  const dates = new Set([...staff.map((r) => r.date), ...florist.map((r) => r.date)]);
  return [...dates].sort().map((date) => ({
    date,
    staff: staff.find((r) => r.date === date)?.count ?? 0,
    florist: florist.find((r) => r.date === date)?.count ?? 0,
  }));
}

export default function LoginsSection({ data }: { data: LoginStats }) {
  const rows = merge(data.staffLoginsByDay, data.floristLoginsByDay);
  return (
    <ChartCard title="Sign-ins per day">
      {rows.length === 0 ? (
        <ChartEmpty label="No sign-ins in this range." />
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={rows}>
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--ink-faint)" }} stroke="var(--line)" />
            <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--ink-faint)" }} stroke="var(--line)" />
            <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12, color: "var(--ink)" }} />
            <Legend wrapperStyle={{ fontSize: 12, color: "var(--ink-soft)" }} />
            <Line type="monotone" dataKey="staff" name="Staff" stroke={CHART_COLORS[0]} strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="florist" name="Florist" stroke={CHART_COLORS[1]} strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}
