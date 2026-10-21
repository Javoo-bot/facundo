// Presenter-facing link/path helpers for the Demo Control Room (/testing).
//
// Pure and alias-free (relative imports only, no "@/") so plain `node --test`
// can reach it — same convention as lib/testing/demoSink.ts and
// lib/testing/orderScenarios.ts.

/** The staff backoffice order detail page for a given demo (or real) order id. */
export function backofficeOrderPath(orderId: string): string {
  if (!orderId || !orderId.trim()) return "/orders";
  return `/orders/${orderId}`;
}

/** The florist-facing order page for a given assignment id.
 *
 * Mirrors orderDest() in lib/floristMagicLink.ts EXACTLY — that is the path a
 * real magic link deep-links to, and this is what the Demo Control Room shows
 * as a plain (non-authenticating) reference link. If the two ever need to
 * diverge, change both together or one will silently point at a dead route. */
export function floristOrderPath(assignmentId: string): string {
  if (!assignmentId || !assignmentId.trim()) return "/florist/orders";
  return `/florist/orders/${assignmentId}`;
}

/** The Demo Control Room's own split view (backoffice + florist side by side)
 *  for a given demo order. */
export function demoSplitViewPath(orderId: string): string {
  if (!orderId || !orderId.trim()) return "/testing";
  return `/testing/demo/${orderId}`;
}

export interface DemoIdBundle {
  orderId: string;
  floristId: string | null;
  assignmentId: string | null;
}

/** Multi-line "order: <id>\nflorist: <id>\nassignment: <id>" for a copy-to-
 *  clipboard button — lines for null/blank ids are omitted rather than
 *  printed as "florist: null", since the CTR shows this to a presenter, not
 *  a debugger. */
export function formatDemoIds(b: DemoIdBundle): string {
  const lines: string[] = [];
  if (b.orderId && b.orderId.trim()) lines.push(`order: ${b.orderId}`);
  if (b.floristId && b.floristId.trim()) lines.push(`florist: ${b.floristId}`);
  if (b.assignmentId && b.assignmentId.trim()) lines.push(`assignment: ${b.assignmentId}`);
  return lines.join("\n");
}
