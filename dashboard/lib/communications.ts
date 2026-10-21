import { createServiceClient } from "@/lib/supabaseAdmin";
import { buildCommunicationRow } from "./communicationsRow";
import type { CommunicationInput } from "./communicationsRow";

// The unified communications log (Workstream A of the comms hub). One row per
// outbound message — email or push, across every audience — WITH the actual
// content, so /communications, the per-order section, and the per-florist
// list all have one place to read from. Distinct from external_ops (call-level
// provider audit, unchanged) and outreach (recruiting-only, pre-phase0).
//
// Row assembly (buildCommunicationRow) lives in ./communicationsRow, which has
// no runtime imports, so it unit-tests under plain `node --test` without
// pulling in this file's supabaseAdmin import — re-exported here for callers.
export { buildCommunicationRow };
export type { CommunicationInput };

// Inserts one row via the service client. Never throws — a logging failure
// must never break the send it records (mirrors lib/externalOps.ts::logExternalOp).
export async function logCommunication(input: CommunicationInput): Promise<void> {
  try {
    const admin = createServiceClient();
    await admin.from("communications").insert(buildCommunicationRow(input));
  } catch {
    // swallow — logging must never break the call it records
  }
}
