export function slaClass(deadlineIso: string | null): string {
  if (!deadlineIso) return "sla sla-ok";
  const ms = new Date(deadlineIso).getTime() - Date.now();
  if (ms <= 30 * 60 * 1000) return "sla sla-crit";       // <30m or overdue
  if (ms <= 2 * 60 * 60 * 1000) return "sla sla-warn";    // 30m–2h
  return "sla sla-ok";                                    // >2h
}

export default function SlaDot({ deadlineIso, label }: { deadlineIso: string | null; label: string }) {
  return <span className={slaClass(deadlineIso)}>{label}</span>;
}
