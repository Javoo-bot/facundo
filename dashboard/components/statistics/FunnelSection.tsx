"use client";
import { StatTile, ChartCard, ChartEmpty } from "./ChartPrimitives";
import type { FunnelStats, FunnelStepStats } from "@/lib/opsStats";

// The outreach funnel, per touch. Distinct from the Emails section above, which
// counts every email we send: an order offer and a day-7 recruiting touch are
// the same row to that one. The only useful version of "is the funnel working"
// is which ANGLE earns the click, so this reports per step.

const STEP_LABEL: Record<string, string> = {
  t1: "1 · first email",
  t2: "2 · we're short here",
  t3: "3 · how the money works",
  r1: "R1 · what stopped you?",
  r2: "R2 · closing this off",
  co1: "C1 · that order went elsewhere",
  co2: "C2 · the next order",
};

// Funnel order, not alphabetical — the sequence is the story.
const STEP_ORDER = ["t1", "t2", "t3", "r1", "r2", "co1", "co2"];

function pct(n: number, d: number): string {
  if (d <= 0) return "—";
  return `${Math.round((n / d) * 100)}%`;
}

export default function FunnelSection({ data }: { data: FunnelStats }) {
  const byStep = new Map<string, FunnelStepStats[]>();
  for (const s of data.steps) {
    if (!byStep.has(s.step)) byStep.set(s.step, []);
    byStep.get(s.step)!.push(s);
  }
  const steps = STEP_ORDER.filter((k) => byStep.has(k)).concat(
    [...byStep.keys()].filter((k) => !STEP_ORDER.includes(k)).sort()
  );

  const totalSent = data.steps.reduce((a, s) => a + s.sent, 0);
  const totalSkipped = data.steps.reduce((a, s) => a + s.skipped, 0);

  const runs = data.enrolments.reduce((a, e) => a + e.n, 0);
  const engaged = data.enrolments.reduce((a, e) => a + e.engaged, 0);
  const joined = data.enrolments.filter((e) => e.status === "converted").reduce((a, e) => a + e.n, 0);
  const exhausted = data.enrolments.filter((e) => e.status === "exhausted").reduce((a, e) => a + e.n, 0);
  const stopped = data.enrolments.filter((e) => e.status === "stopped").reduce((a, e) => a + e.n, 0);

  if (totalSent === 0 && runs === 0) {
    return <ChartEmpty label="The outreach funnel hasn't run in this range." />;
  }

  const maxSent = Math.max(1, ...steps.map((k) => (byStep.get(k) ?? []).reduce((a, s) => a + s.sent, 0)));

  return (
    <section style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        <StatTile label="Runs started" value={String(runs)} />
        <StatTile label="Engaged (any channel)" value={`${engaged} · ${pct(engaged, runs)}`} />
        <StatTile label="Joined" value={`${joined} · ${pct(joined, runs)}`} />
        <StatTile label="Messages sent" value={String(totalSent)} />
      </div>

      <ChartCard title="By touch">
        {steps.length === 0 ? (
          <ChartEmpty label="No touches sent in this range." />
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {steps.map((key) => {
              const rows = byStep.get(key) ?? [];
              const sent = rows.reduce((a, s) => a + s.sent, 0);
              const clicked = rows.reduce((a, s) => a + s.clicked, 0);
              const delivered = rows.reduce((a, s) => a + s.delivered, 0);
              const skipped = rows.reduce((a, s) => a + s.skipped, 0);
              const sms = rows.find((s) => s.channel === "sms");
              return (
                <div key={key} style={{ display: "grid", gap: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: ".8rem" }}>
                    <span style={{ color: "var(--ink)" }}>{STEP_LABEL[key] ?? key}</span>
                    <span style={{ color: "var(--ink-soft)" }}>
                      {sent} sent · {delivered} delivered · {clicked} clicked ({pct(clicked, delivered || sent)})
                      {sms ? ` · sms ${sms.sent}/${sms.sent + sms.skipped}` : ""}
                      {skipped > 0 ? ` · ${skipped} skipped` : ""}
                    </span>
                  </div>
                  <div
                    style={{ background: "var(--line)", borderRadius: 4, overflow: "hidden", height: 12, position: "relative" }}
                    role="img"
                    aria-label={`${STEP_LABEL[key] ?? key}: ${sent} sent, ${clicked} clicked`}
                  >
                    <div style={{ width: `${(sent / maxSent) * 100}%`, background: "var(--accent)", height: "100%" }} />
                    <div
                      style={{
                        position: "absolute", inset: 0,
                        width: `${(clicked / maxSent) * 100}%`,
                        background: "var(--ink)", opacity: 0.55, height: "100%",
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <p style={{ marginTop: 10, fontSize: ".72rem", color: "var(--ink-faint)" }}>
          <strong>Per-touch clicks are email only.</strong> An SMS click goes through our own short link, which
          the email provider never sees — so &ldquo;Engaged&rdquo; above can exceed the clicks shown here, and
          that difference is SMS. The two numbers are measuring different things, not disagreeing.
        </p>
        <p style={{ marginTop: 6, fontSize: ".72rem", color: "var(--ink-faint)" }}>
          Clicks are the raw provider count and <strong>include link scanners</strong> — corporate mail gateways
          open every URL at delivery. Those are stored but never advance a run, so a step whose clicks far exceed
          its engaged count is being read by machines, not florists. That gap is the useful signal, which is why
          it isn&apos;t filtered out here.
        </p>
      </ChartCard>

      <ChartCard title="How runs ended">
        {data.enrolments.length === 0 ? (
          <ChartEmpty label="No runs in this range." />
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
              <StatTile label="Joined" value={String(joined)} />
              <StatTile label="Saw every touch" value={String(exhausted)} />
              <StatTile label="Stopped early" value={String(stopped)} />
              <StatTile label="Skipped sends" value={String(totalSkipped)} />
            </div>
            <p style={{ marginTop: 10, fontSize: ".72rem", color: "var(--ink-faint)" }}>
              &ldquo;Saw every touch&rdquo; is the normal end of a funnel, not a failure — the prospect got the
              whole sequence and passes to long-term nurture. &ldquo;Stopped early&rdquo; is an opt-out, a bounce,
              a complaint, or staff intervention.
            </p>
            <div style={{ marginTop: 10, display: "grid", gap: 4 }}>
              {data.enrolments.map((e, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: ".78rem" }}>
                  <span style={{ color: "var(--ink-soft)" }}>
                    {e.sequence_id} · {e.status}
                    {e.stop_reason ? ` (${e.stop_reason})` : ""}
                  </span>
                  <span style={{ color: "var(--ink)" }}>
                    {e.n}
                    {e.engaged > 0 ? ` · ${e.engaged} engaged` : ""}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </ChartCard>
    </section>
  );
}
