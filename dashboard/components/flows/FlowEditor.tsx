"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Locale } from "@/lib/i18n";
import MessageEditor from "@/components/messages/MessageEditor";
import {
  CHANNEL_SIBLINGS,
  listedMessageIds,
  chainPositions,
  messageName,
  MESSAGE_TOGGLE_COLUMN,
  type FlowDef,
} from "@/lib/flows/catalog";
import { isCopy } from "@/lib/flows/customSteps";
import { timingKey, type StepEnabled } from "@/lib/flows/timing";

// A funnel's messages. Pick one on the left, read it on the right, type in it,
// save. That is the whole screen.
//
// It is /messages, scoped to this funnel and put in its simple mode — the same
// component, not a copy. Two editors over one draft table would be two ways
// for the wrong words to reach a florist, and the interaction that matters
// (click the text in the rendered email and change it) is already built.
//
// Wait time is NOT here. Minutes have nothing to do with wording, and putting
// a clock next to a subject line is what made the earlier versions of this
// screen unreadable. It lives on /flows/wait-time.

interface FlowsPayload {
  flows: FlowDef[];
  stepEnabled: StepEnabled;
  /** The event-driven messages' switches, by message id. */
  messageEnabled: Record<string, boolean>;
}

export default function FlowEditor({ flowId, locales }: { flowId: string; locales: Locale[] }) {
  const [flows, setFlows] = useState<FlowDef[] | null>(null);
  const [stepEnabled, setStepEnabled] = useState<StepEnabled>({});
  const [messageEnabled, setMessageEnabled] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/flows", { cache: "no-store" });
      const json = (await res.json()) as FlowsPayload & { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not load the funnels.");
      setFlows(json.flows);
      setStepEnabled(json.stepEnabled ?? {});
      setMessageEnabled(json.messageEnabled ?? {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const flow = useMemo(() => flows?.find((f) => f.id === flowId) ?? null, [flows, flowId]);
  const only = useMemo(() => (flow ? listedMessageIds(flow) : []), [flow]);

  // "3. We are short here". The number is what makes the list read as a chain
  // rather than a set, and it is the same number Wait time shows, so an
  // operator can move between the two screens and land on the same email.
  //
  // A DUPLICATE takes its source's name with its own number — it is a proper
  // email in the chain, not a sub-item of the one it was copied from.
  const numberedNames = useMemo(() => {
    if (!flow) return {};
    const positions = chainPositions(flow);
    return Object.fromEntries(
      only.map((id) => [id, { label: `${positions[id] ?? "?"}. ${messageName(id)}` }])
    );
  }, [flow, only]);

  // Which message belongs to which funnel step, so a row's tick knows what to
  // switch off. Only steps the sequence engine schedules can be switched off:
  // an order still has to be offered to somebody, so the offer and the
  // thank-you get no tick rather than one that refuses.
  const stepFor = useMemo(() => {
    const map: Record<string, { sequenceId: string; stepKey: string }> = {};
    for (const step of flow?.steps ?? []) {
      if (!step.timing) continue;
      for (const id of step.messageIds) {
        map[id] = { sequenceId: step.timing.sequenceId, stepKey: step.timing.stepKey };
      }
    }
    return map;
  }, [flow]);

  const rowState = useMemo(() => {
    const out: Record<string, { off: boolean; canToggle: boolean; canDuplicate: boolean; isCopy: boolean }> = {};
    for (const id of only) {
      const step = stepFor[id];
      const copy = Boolean(step && isCopy(step.stepKey));
      // Two kinds of switch, because there are two kinds of message. A
      // scheduled touch is switched off on its funnel step; an event-driven
      // one (the offer, the thank-you) has no step, and its switch is the
      // per-kind setting its send site already checks.
      const settingSwitch = MESSAGE_TOGGLE_COLUMN[id] !== undefined;
      out[id] = {
        canToggle: Boolean(step) || settingSwitch,
        off: step
          ? stepEnabled[timingKey(step.sequenceId, step.stepKey)] === false
          : settingSwitch && messageEnabled[id] === false,
        // Only a scheduled step can be duplicated, and only one level deep —
        // the offer and the thank-you fire on an event, so a second copy of
        // them would have nothing to be scheduled by.
        canDuplicate: Boolean(step) && !copy,
        isCopy: copy,
      };
    }
    return out;
  }, [only, stepFor, stepEnabled, messageEnabled]);

  const duplicateRow = useCallback(
    async (messageId: string) => {
      const step = stepFor[messageId];
      if (!step) return;
      const res = await fetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "duplicate", sequenceId: step.sequenceId, stepKey: step.stepKey }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error ?? "Could not duplicate."); return; }
      await load();
    },
    [stepFor, load]
  );

  const deleteRow = useCallback(
    async (messageId: string) => {
      const step = stepFor[messageId];
      if (!step) return;
      // The one destructive action on this screen, and it takes the words with
      // it, so it asks.
      if (!window.confirm("Delete this copy? Its wording goes with it.")) return;
      const res = await fetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "deleteCustom", sequenceId: step.sequenceId, stepKey: step.stepKey }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error ?? "Could not delete."); return; }
      await load();
    },
    [stepFor, load]
  );

  const toggleRow = useCallback(
    async (messageId: string, next: boolean) => {
      const step = stepFor[messageId];
      if (!step) {
        // An event-driven message: its switch is an app_settings column.
        if (!MESSAGE_TOGGLE_COLUMN[messageId]) return;
        setMessageEnabled((prev) => ({ ...prev, [messageId]: next }));
        const res = await fetch("/api/flows", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "messageToggle", messageId, enabled: next }),
        });
        if (!res.ok) await load();
        return;
      }
      const key = timingKey(step.sequenceId, step.stepKey);
      // Optimistic: the tick should feel like a switch, not a form.
      setStepEnabled((prev) => {
        const copy = { ...prev };
        if (next) delete copy[key]; else copy[key] = false;
        return copy;
      });
      const res = await fetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "enabled", sequenceId: step.sequenceId, stepKey: step.stepKey, enabled: next }),
      });
      if (!res.ok) await load(); // put the tick back where the server says
    },
    [stepFor, load]
  );

  const reorderRow = useCallback(
    async (messageId: string, afterMessageId: string) => {
      const step = stepFor[messageId];
      const after = stepFor[afterMessageId];
      if (!step || !after) return;
      const res = await fetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "moveCustom",
          sequenceId: step.sequenceId,
          stepKey: step.stepKey,
          afterStepKey: after.stepKey,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error ?? "Could not move it."); return; }
      await load();
    },
    [stepFor, load]
  );

  if (error) return <p className="text-sm" style={{ color: "var(--crit)" }}>{error}</p>;
  if (!flow) return <p className="text-sm text-ink-faint">Loading…</p>;

  const offCount = Object.values(rowState).filter((r) => r.off).length;

  return (
    <div>
      <h1 style={{ margin: "0 0 4px", fontSize: "1.2rem" }}>{flow.label}</h1>
      <p style={{ margin: "0 0 16px", fontSize: ".78rem", color: "var(--ink-faint)" }}>
        {offCount === 0
          ? "Untick an email to stop sending it."
          : `${offCount} of these is switched off. Untick to stop sending, tick to start again.`}
      </p>
      <MessageEditor
        locales={locales}
        scope={{
          only,
          labels: numberedNames,
          simple: true,
          siblings: CHANNEL_SIBLINGS,
          rowState,
          onToggleRow: toggleRow,
          onDuplicateRow: duplicateRow,
          onDeleteRow: deleteRow,
          onReorderRow: reorderRow,
        }}
      />
    </div>
  );
}
