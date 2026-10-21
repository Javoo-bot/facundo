"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";

type State = "idle" | "busy" | "snoozed" | "stopped" | "error";

export default function UnsubscribeActions({
  token,
  channel,
  alreadyStopped,
  alreadySnoozed,
  labels,
}: {
  token: string;
  channel: "email" | "sms";
  alreadyStopped: boolean;
  alreadySnoozed: boolean;
  labels: {
    snooze: string;
    stop: string;
    snoozedConfirm: string;
    stoppedConfirm: string;
    error: string;
  };
}) {
  const [state, setState] = useState<State>(alreadyStopped ? "stopped" : alreadySnoozed ? "snoozed" : "idle");

  async function act(action: "snooze" | "stop") {
    setState("busy");
    try {
      const res = await fetch("/api/florist/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action, channel }),
      });
      if (!res.ok) {
        setState("error");
        return;
      }
      setState(action === "snooze" ? "snoozed" : "stopped");
    } catch {
      setState("error");
    }
  }

  if (state === "stopped") return <p style={{ color: "var(--accent)", fontSize: ".9rem" }}>{labels.stoppedConfirm}</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {state === "snoozed" && <p style={{ color: "var(--accent)", fontSize: ".9rem" }}>{labels.snoozedConfirm}</p>}
      <Button variant="solid" disabled={state === "busy"} onClick={() => act("snooze")}>
        {labels.snooze}
      </Button>
      <Button variant="default" disabled={state === "busy"} onClick={() => act("stop")}>
        {labels.stop}
      </Button>
      {state === "error" && <p style={{ color: "var(--crit)", fontSize: ".85rem" }}>{labels.error}</p>}
    </div>
  );
}
