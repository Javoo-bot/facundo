"use client";

import { useState } from "react";
import Link from "next/link";
import { SCENARIOS } from "@/lib/testing/scenarios";
import { tickBlockedCopy } from "@/lib/sequences/tickBlocked";

/**
 * Test stores: create a florist in a known state and drive the real flows at it.
 *
 * Everything here calls the SAME functions the cron and the webhooks call —
 * `runSequences`, `recordEngagement`, `ingestInbound`. A harness that mocks the
 * send tests the harness, not the funnel, so these are real sends to an address
 * you choose.
 */

export interface TestShop {
  id: string;
  name: string | null;
  email: string | null;
  locale: string | null;
  joined_at: string | null;
  ingested_at: string | null;
  cities: { city: string | null } | null;
  sequence_enrolments: {
    id: string; sequence_id: string; status: string; track: string;
    step_index: number; next_action_at: string | null; engaged_at: string | null;
    touches_email: number; stop_reason: string | null;
  }[];
}

export interface CityOption { id: string; city: string | null; country: string | null }

const SEQUENCES = [
  { id: "recruit_cold", label: "Cold recruiting" },
  { id: "reactivate_never_accepted", label: "Reactivation — no first order" },
  { id: "reactivate_dormant", label: "Reactivation — dormant" },
  { id: "cold_offer_followup", label: "Cold-offer follow-up" },
];

function when(ts: string | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

export default function TestingClient({
  initialShops,
  cities,
  defaultEmail,
  engineOn,
  agentOn,
  testMode,
  error,
}: {
  initialShops: TestShop[];
  cities: CityOption[];
  defaultEmail: string;
  engineOn: boolean;
  agentOn: boolean;
  testMode: boolean;
  error: string | null;
}) {
  const [shops, setShops] = useState(initialShops);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [scenario, setScenario] = useState(SCENARIOS[0].id);
  const [email, setEmail] = useState(defaultEmail);
  const [cityId, setCityId] = useState(cities[0]?.id ?? "");
  const [replyText, setReplyText] = useState("Thanks — do I have to take every order?");

  function say(line: string) {
    setLog((l) => [`${new Date().toLocaleTimeString()}  ${line}`, ...l].slice(0, 40));
  }

  async function call(payload: Record<string, unknown>, describe: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/testing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `Failed (${res.status}).`);
      // A tick that returned without looking at anything says why, in words. It
      // is otherwise indistinguishable from a tick that found nothing due, and
      // the log is where you go first when a send doesn't arrive.
      const blocked = tickBlockedCopy(j.result?.blocked);
      say(blocked ? `${describe} → ${blocked}` : `${describe} → ${JSON.stringify(j.result ?? j.reason ?? "ok")}`);
      if (!engineOn && (payload.action === "enrol" || payload.action === "fastForward")) {
        say("   ↳ note: the funnel is off, so this changed state but will not send.");
      }
      await refresh();
      return j;
    } catch (e) {
      say(`${describe} → ${e instanceof Error ? e.message : "failed"}`);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    const res = await fetch("/api/testing/shops");
    if (res.ok) setShops((await res.json()).shops as TestShop[]);
  }

  const chosen = SCENARIOS.find((s) => s.id === scenario)!;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <p className="eyebrow">Backoffice</p>
      <h1>Test stores</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Create a florist in a known state and run the real flows at it. Every button here calls the same code
        the cron and the webhooks call — nothing is mocked, so what you see is what a real florist would get.
      </p>

      {!testMode && (
        <p className="mt-4 rounded-md border border-crit px-3 py-2 text-sm text-crit">
          🔴 Test mode is OFF, so these go out for real to the address you enter below. That is usually what
          you want here — just make sure it&apos;s an inbox you can read.
        </p>
      )}
      {/* The engine being off deserves its own banner, not a clause in a list.
          Enrol and Fast-forward still succeed while it's off — they only write
          rows — so the page answers "ok" to everything and sends nothing, which
          reads as a broken send rather than a switch. Say so before that
          happens, not after. */}
      {!engineOn && (
        <p className="mt-3 rounded-md border border-crit px-3 py-2 text-sm text-crit">
          ⚠️ <strong>The recruiting funnel is switched off, so nothing on this page will send.</strong>{" "}
          Enrol and Fast-forward will still say “ok” — they only write rows — and Run tick will do
          nothing at all. Turn it on at{" "}
          <Link href="/settings?tab=outreach" className="underline">
            Settings → Outreach
          </Link>
          , then come back and press Run tick.
        </p>
      )}
      {!agentOn && (
        <p className="mt-3 rounded-md border border-warn px-3 py-2 text-sm text-warn">
          The CX assistant is off, so a reply will escalate instead of being answered.{" "}
          <Link href="/settings?tab=outreach" className="underline">
            Settings → Outreach
          </Link>
          .
        </p>
      )}
      {error && <p className="mt-3 rounded-md border border-crit px-3 py-2 text-sm text-crit">{error}</p>}

      {/* ---- create ---- */}
      <section className="mt-6 rounded-md border border-line p-4">
        <h2 className="text-sm font-semibold text-ink">New test store</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="text-sm sm:col-span-3">
            <span className="text-ink-soft">Scenario</span>
            <select
              value={scenario}
              onChange={(e) => setScenario(e.target.value as typeof scenario)}
              className="mt-1 w-full rounded-md border border-line-strong px-2 py-1.5 text-sm"
            >
              {SCENARIOS.map((s) => (
                <option key={s.id} value={s.id}>{s.label} — {s.blurb}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-faint">{chosen.expect}</p>
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="text-ink-soft">Send to</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-line-strong px-3 py-1.5 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="text-ink-soft">City</span>
            <select
              value={cityId}
              onChange={(e) => setCityId(e.target.value)}
              className="mt-1 w-full rounded-md border border-line-strong px-2 py-1.5 text-sm"
            >
              {cities.map((c) => (
                <option key={c.id} value={c.id}>{c.city} · {c.country}</option>
              ))}
            </select>
          </label>
        </div>
        <button
          type="button"
          disabled={busy || !email || !cityId}
          onClick={() => void call({ action: "create", scenario, email, cityId }, `create ${scenario}`)}
          className="mt-3 rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Working…" : "Create test store"}
        </button>
      </section>

      {/* ---- shops ---- */}
      <h2 className="mt-8 text-sm font-semibold text-ink">Test stores ({shops.length})</h2>
      <ul className="mt-2 divide-y divide-line rounded-md border border-line">
        {shops.length === 0 ? (
          <li className="px-3 py-3 text-sm text-ink-soft">None yet.</li>
        ) : (
          shops.map((s) => {
            const run = s.sequence_enrolments.find((e) => e.status === "active" || e.status === "paused");
            return (
              <li key={s.id} className="px-3 py-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-ink">{s.name}</p>
                    <p className="text-xs text-ink-faint">
                      {s.email} · {s.cities?.city ?? "no city"} · {s.locale ?? "no locale"} ·{" "}
                      {s.joined_at ? "in the network" : "prospect"}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-soft">
                      {run
                        ? `${run.sequence_id} · ${run.track} · step ${run.step_index} · ${run.touches_email} sent · next ${when(run.next_action_at)}${run.engaged_at ? " · clicked" : ""}`
                        : s.sequence_enrolments.length > 0
                          ? `no live run (${s.sequence_enrolments[0].stop_reason ?? s.sequence_enrolments[0].status})`
                          : "not enrolled"}
                    </p>
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <select
                    id={`seq-${s.id}`}
                    defaultValue="recruit_cold"
                    className="rounded-md border border-line-strong px-2 py-1 text-xs"
                  >
                    {SEQUENCES.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}
                  </select>
                  <Btn busy={busy} onClick={() => {
                    const el = document.getElementById(`seq-${s.id}`) as HTMLSelectElement | null;
                    return call({ action: "enrol", floristId: s.id, sequenceId: el?.value }, `enrol ${s.name}`);
                  }}>Enrol</Btn>
                  <Btn busy={busy} onClick={() => call({ action: "fastForward", floristId: s.id, days: 3 }, "+3 days")}>+3d</Btn>
                  <Btn busy={busy} onClick={() => call({ action: "fastForward", floristId: s.id, days: 7 }, "+7 days")}>+7d</Btn>
                  <Btn busy={busy} onClick={() => call({ action: "tick" , floristId: s.id }, "run tick")}>Run tick</Btn>
                  <Btn busy={busy} onClick={() => call({ action: "click", floristId: s.id }, "simulate click")}>Click a link</Btn>
                  <Btn busy={busy} onClick={() => call({ action: "reply", floristId: s.id, text: replyText }, "inbound reply")}>Reply</Btn>
                  <Btn busy={busy} onClick={() => call({ action: "stopRuns", floristId: s.id }, "stop runs")}>Stop</Btn>
                  <Btn busy={busy} onClick={() => call({ action: "reset", floristId: s.id }, "reset")}>Reset</Btn>
                  <Btn busy={busy} danger onClick={() => call({ action: "delete", floristId: s.id }, "delete")}>Delete</Btn>
                </div>
              </li>
            );
          })
        )}
      </ul>

      <label className="mt-3 block text-sm">
        <span className="text-ink-soft">What the florist says when you press Reply</span>
        <input
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          className="mt-1 w-full rounded-md border border-line-strong px-3 py-1.5 text-sm"
        />
        <span className="mt-1 block text-xs text-ink-faint">
          Try &ldquo;what commission do you take?&rdquo; to see the money escalation, or &ldquo;am I talking to
          a person?&rdquo; to see the disclosure.
        </span>
      </label>

      {log.length > 0 && (
        <>
          <h2 className="mt-8 text-sm font-semibold text-ink">What happened</h2>
          <pre className="mt-2 max-h-72 overflow-auto rounded-md border border-line bg-surface-2 p-3 text-xs text-ink-soft">
            {log.join("\n")}
          </pre>
        </>
      )}
    </div>
  );
}

function Btn({
  children, onClick, busy, danger,
}: {
  children: React.ReactNode;
  onClick: () => void | Promise<unknown>;
  busy: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void onClick()}
      className={`rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-50 ${
        danger ? "border-crit text-crit hover:bg-surface-2" : "border-line-strong hover:bg-surface-2"
      }`}
    >
      {children}
    </button>
  );
}
