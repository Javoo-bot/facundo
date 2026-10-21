"use client";
import { staffSettableStatuses, type MoveDirection } from "@/lib/orderStages";
import { ORDER_STATUS_LABEL, type OrderStatus } from "@/lib/orderStatus";
import ActionMenu, { type ActionGroup, type Tone } from "@/components/ui/ActionMenu";

const DIR_META: Record<MoveDirection, { heading: string; tone: Tone }> = {
  forward: { heading: "Advance", tone: "default" },
  back: { heading: "Move back", tone: "warn" },
  flag: { heading: "Flag", tone: "crit" },
};
const GROUPS: MoveDirection[] = ["forward", "back", "flag"];

// Manual stage control. Lists the guardrailed staff-settable statuses grouped by
// direction; forward moves fire immediately, back/flag moves are confirmed by
// the caller (which also surfaces any server-side payout warning). The dropdown
// plumbing itself lives in ui/ActionMenu — shared with the reach-out row menu.
export default function ChangeStageMenu({
  current,
  busy,
  onSelect,
}: {
  current: OrderStatus;
  busy: boolean;
  onSelect: (to: OrderStatus, dir: MoveDirection) => void;
}) {
  const moves = staffSettableStatuses(current);
  const groups: ActionGroup[] = GROUPS.map((g) => ({
    key: g,
    heading: DIR_META[g].heading,
    tone: DIR_META[g].tone,
    items: moves
      .filter((m) => m.direction === g)
      .map((m) => ({ key: m.status, label: ORDER_STATUS_LABEL[m.status], onSelect: () => onSelect(m.status, m.direction) })),
  }));

  return <ActionMenu label="Change stage" groups={groups} busy={busy} />;
}
