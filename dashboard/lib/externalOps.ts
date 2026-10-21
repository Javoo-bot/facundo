import { createServiceClient } from "./supabaseAdmin.ts";

// A uniform log of every call to an external service (Shopify, Airwallex, Resend),
// inbound and outbound. One row per call, written best-effort from the code that
// makes the call — a logging failure must NEVER affect the operation it records.
// Read-only in the backoffice under SYSTEM → External operations.

export interface ExternalOp {
  provider: string; // 'shopify' | 'airwallex' | 'resend' | 'ongage'
  operation: string; // 'writeback_status' | 'issue_card' | 'send_email' | 'webhook_order' ...
  direction?: "in" | "out"; // default 'out' (we called them); 'in' = they called us
  orderId?: string | null; // our internal order id when known
  ref?: string | null; // provider/order ref (shopify order id, provider_ref, message id)
  ok?: boolean | null; // null = attempted/unknown; true/false = outcome
  skipped?: boolean; // blocked by a safeguard (e.g. writeback disabled)
  statusCode?: number | null;
  durationMs?: number | null;
  error?: string | null;
  meta?: Record<string, unknown> | null;
}

export async function logExternalOp(op: ExternalOp): Promise<void> {
  try {
    const admin = createServiceClient();
    await admin.from("external_ops").insert({
      provider: op.provider,
      operation: op.operation,
      direction: op.direction ?? "out",
      order_id: op.orderId ?? null,
      ref: op.ref ?? null,
      ok: op.ok ?? null,
      skipped: op.skipped ?? false,
      status_code: op.statusCode ?? null,
      duration_ms: op.durationMs ?? null,
      error: op.error ?? null,
      meta: op.meta ?? null,
    });
  } catch {
    // swallow — logging must never break the call it records
  }
}
