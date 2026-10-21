"use client";

import { useState } from "react";
import Link from "next/link";
import { ORDER_SCENARIOS } from "@/lib/testing/orderScenarios";
import DemoOrderRow from "./DemoOrderRow";
import EmptyState from "@/components/EmptyState";
import type { CityOption } from "./TestingClient";

/**
 * Production/order-loop demo sandbox: creates a demo shop + a demo order and
 * drives it through a scenario using the REAL matching/offer/payout code —
 * never a real florist, never a real card. See lib/testing/demoSandbox.ts.
 */

export interface DemoOrder {
  id: string;
  order_name: string | null;
  status: string;
  demo_source_order_id: string | null;
  delivery_area: string | null;
  created_at: string;
  order_assignments: {
    id: string; florist_id: string; status: string; payout_price: number | null;
    offer_expires_at: string | null; accepted_at: string | null; delivered_at: string | null;
  }[];
}

interface BatchResult {
  scenarioId: string;
  label: string;
  ok: boolean;
  orderId: string | null;
  floristId: string | null;
  assignmentId: string | null;
  steps: string[];
  warnings: string[];
  error: string | null;
}

export default function OrderSandboxPanel({
  initialOrders,
  cities,
  testEmailConfigured,
  testEmail,
  testPhone,
}: {
  initialOrders: DemoOrder[];
  cities: CityOption[];
  testEmailConfigured: boolean;
  testEmail: string | null;
  testPhone: string | null;
}) {
  const [orders, setOrders] = useState(initialOrders);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [batch, setBatch] = useState<{ ran: number; succeeded: number; failed: number; results: BatchResult[] } | null>(null);
  const [scenarioId, setScenarioId] = useState(ORDER_SCENARIOS[0].id);
  const [cityId, setCityId] = useState(cities[0]?.id ?? "");
  const [sourceOrderId, setSourceOrderId] = useState("");

  function say(line: string) {
    setLog((l) => [`${new Date().toLocaleTimeString()}  ${line}`, ...l].slice(0, 40));
  }

  async function refresh() {
    const res = await fetch("/api/testing/orders");
    if (res.ok) setOrders((await res.json()).orders as DemoOrder[]);
  }

  async function setup() {
    setBusy(true);
    setBatch(null);
    try {
      const res = await fetch("/api/testing/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "setup",
          scenarioId,
          cityId: cityId || undefined,
          sourceOrderId: sourceOrderId.trim() || undefined,
        }),
      });
      const j = await res.json();
      if (!res.ok) {
        say(`set up ${scenarioId} → ${j.error || `failed (${res.status})`}`);
        return;
      }
      say(`set up ${scenarioId} → order #${j.orderId?.slice(0, 8)} — ${j.steps.join("; ")}${j.warnings?.length ? ` ⚠️ ${j.warnings.join("; ")}` : ""}`);
      await refresh();
    } catch (e) {
      say(`set up ${scenarioId} → ${e instanceof Error ? e.message : "failed"}`);
    } finally {
      setBusy(false);
    }
  }

  async function setupAll() {
    setBusy(true);
    setBatch(null);
    try {
      const res = await fetch("/api/testing/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "setup_all",
          cityId: cityId || undefined,
          sourceOrderId: sourceOrderId.trim() || undefined,
        }),
      });
      const j = await res.json();
      if (!res.ok) {
        say(`create all scenarios → ${j.error || `failed (${res.status})`}`);
        return;
      }
      setBatch({ ran: j.ran, succeeded: j.succeeded, failed: j.failed, results: j.results ?? [] });
      say(`create all scenarios → ${j.succeeded}/${j.ran} succeeded`);
      await refresh();
    } catch (e) {
      say(`create all scenarios → ${e instanceof Error ? e.message : "failed"}`);
    } finally {
      setBusy(false);
    }
  }

  async function cleanup() {
    setBusy(true);
    try {
      const res = await fetch("/api/testing/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cleanup" }),
      });
      const j = await res.json();
      if (!res.ok) {
        say(`cleanup → ${j.error || `failed (${res.status})`}`);
        return;
      }
      say(`cleanup → removed ${j.ordersDeleted} demo order(s), ${j.shopsDeleted} demo shop(s)`);
      setBatch(null);
      await refresh();
    } catch (e) {
      say(`cleanup → ${e instanceof Error ? e.message : "failed"}`);
    } finally {
      setBusy(false);
    }
  }

  const chosen = ORDER_SCENARIOS.find((s) => s.id === scenarioId)!;

  return (
    <section className="mt-10 rounded-md border border-line p-4">
      <p className="eyebrow">Backoffice</p>
      <h2 className="text-sm font-semibold text-ink">🧪 Demo order sandbox</h2>
      <p className="mt-1 text-xs text-ink-soft">
        Production/order-loop scenarios against demo shops only. Matching, offer sends, and payouts all run
        through the real code — demo shops always route mail/SMS to the configured test sink, and always pay
        on the ledger rail. Never touches a real florist or a real Airwallex card.
      </p>

      {/* Safety panel — prominent, scannable, first thing on the page. */}
      <div
        className={`mt-3 rounded-md border px-3 py-3 text-sm ${
          testEmailConfigured ? "border-line-strong bg-surface-soft" : "border-crit"
        }`}
      >
        <p className="mini-h">Safety</p>
        <dl className="mt-1.5 grid gap-x-4 gap-y-1 sm:grid-cols-2">
          <div className="flex items-baseline gap-1.5">
            <dt className="text-ink-faint">Sink email:</dt>
            <dd className={testEmail ? "text-ink" : "text-crit font-semibold"}>{testEmail ?? "not set"}</dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt className="text-ink-faint">Sink phone:</dt>
            <dd className="text-ink">{testPhone ?? "not set"}</dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt className="text-ink-faint">Real florists:</dt>
            <dd className="text-ink">never targeted — demo shops only (florists.is_test_shop)</dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt className="text-ink-faint">Demo orders:</dt>
            <dd className="text-ink">flagged orders.is_demo, never in the working set</dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt className="text-ink-faint">Payouts:</dt>
            <dd className="text-ink">ledger rail only — never a real Airwallex card</dd>
          </div>
        </dl>
        {!testEmailConfigured && (
          <p className="mt-2 rounded-md border border-crit px-3 py-2 text-sm text-crit">
            🔴 No test email configured — scenarios that need a demo shop are blocked. Set it at{" "}
            <Link href="/settings?tab=outreach" className="underline">Settings → Outreach</Link> first.
          </p>
        )}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="text-sm sm:col-span-3">
          <span className="text-ink-soft">Scenario</span>
          <select
            value={scenarioId}
            onChange={(e) => setScenarioId(e.target.value as typeof scenarioId)}
            className="mt-1 w-full rounded-md border border-line-strong px-2 py-1.5 text-sm"
          >
            {ORDER_SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>{s.label} — {s.blurb}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-ink-faint">{chosen.expect}</p>
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
        <label className="text-sm sm:col-span-2">
          <span className="text-ink-soft">Clone from order id (optional)</span>
          <input
            value={sourceOrderId}
            onChange={(e) => setSourceOrderId(e.target.value)}
            placeholder="real order uuid — leave blank for a fixture bouquet"
            className="mt-1 w-full rounded-md border border-line-strong px-3 py-1.5 text-sm"
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void setup()}
          className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Working…" : "Set up scenario"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void setupAll()}
          className="rounded-md border border-line-strong px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-soft disabled:opacity-50"
        >
          {busy ? "Working…" : `Create all scenarios (${ORDER_SCENARIOS.length})`}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void cleanup()}
          className="rounded-md border border-line-strong px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-soft disabled:opacity-50"
        >
          Clear all demo orders + shops
        </button>
      </div>

      {batch && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-ink">
            Batch result: {batch.succeeded}/{batch.ran} succeeded{batch.failed ? `, ${batch.failed} failed` : ""}
          </h3>
          <ul className="mt-2 divide-y divide-line rounded-md border border-line">
            {batch.results.map((r) => (
              <li key={r.scenarioId} className="px-3 py-2 text-sm">
                <p className={`font-medium ${r.ok ? "text-ok" : "text-crit"}`}>
                  {r.ok ? "✅" : "❌"} {r.label}
                  {r.orderId ? ` · order #${r.orderId.slice(0, 8)}` : ""}
                </p>
                {r.ok && r.steps.length > 0 && (
                  <p className="mt-0.5 text-xs text-ink-soft">{r.steps.join("; ")}</p>
                )}
                {r.warnings.length > 0 && (
                  <p className="mt-0.5 text-xs text-warn">⚠️ {r.warnings.join("; ")}</p>
                )}
                {!r.ok && r.error && (
                  <p className="mt-0.5 text-xs text-crit">{r.error}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <h3 className="mt-6 text-sm font-semibold text-ink">Demo orders ({orders.length})</h3>
      {orders.length === 0 ? (
        <EmptyState
          icon={<span className="text-2xl">🧪</span>}
          title="No demo orders yet"
          description="Set up a single scenario, or create all of them at once, to populate this list."
        />
      ) : (
        <ul className="mt-2 divide-y divide-line rounded-md border border-line">
          {orders.map((o) => <DemoOrderRow key={o.id} order={o} />)}
        </ul>
      )}

      {log.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-ink">Log</h3>
          <ul className="mt-1 space-y-1 text-xs text-ink-soft">
            {log.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}
