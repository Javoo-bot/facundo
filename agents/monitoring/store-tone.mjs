// Stores the daily tone check (agents/garden/tone/geval.py writes tone.json)
// in the garden table agent_tone_scores, so the Concierge and Cupid tone
// measures (advice only) have numbers in Grafana.
//
//   GARDEN_SUPABASE_URL=... GARDEN_SUPABASE_SERVICE_ROLE_KEY=... node agents/monitoring/store-tone.mjs tone.json

import { readFileSync, existsSync } from "node:fs";
import { gardenRest } from "./garden-rest.mjs";
import { toneRows } from "./external-rows.mjs";

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.log(`no tone file at ${file ?? "(none given)"}, nothing stored`);
} else {
  const rows = toneRows(JSON.parse(readFileSync(file, "utf8")));
  if (rows.length) await gardenRest().upsert("agent_tone_scores", rows.map((r) => ({ ...r, scored_at: new Date().toISOString() })), "message_id");
  console.log(`stored ${rows.length} tone scores`);
}
