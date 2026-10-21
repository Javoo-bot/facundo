import type { BadgeInfo } from "./badgeMap";
export { orderStatusBadge, assignmentStatusBadge, sourceBadge } from "./badgeMap";

export default function Badge({ info }: { info: BadgeInfo }) {
  return <span className={`badge ${info.cls}`}>{info.label}</span>;
}
