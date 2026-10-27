// The one place that says which Supabase project is the garden: the ref in
// GARDEN_SUPABASE_URL (https://<ref>.supabase.co). Never written into the
// code, so the public copy of this repo carries no project. Dependency-free on
// purpose: execute-card.mjs and after-merge.mjs import it without pulling the
// dashboard modules cards.mjs needs.

export function gardenRef(env = process.env) {
  const url = env.GARDEN_SUPABASE_URL;
  if (!url) throw new Error("refusing to run: GARDEN_SUPABASE_URL is not set");
  let host;
  try { host = new URL(url).hostname; } catch { throw new Error(`refusing to run: GARDEN_SUPABASE_URL "${url}" is not a URL`); }
  const m = /^([a-z0-9]+)\.supabase\.co$/.exec(host);
  if (!m) throw new Error(`refusing to run: GARDEN_SUPABASE_URL host ${host} is not a Supabase project`);
  return m[1];
}

// Throws unless the URL is the side-project Supabase named by
// GARDEN_SUPABASE_URL. Production must never receive factory cards or be read
// by the sweep.
export function assertGardenUrl(url, env = process.env) {
  const ref = gardenRef(env);
  let host;
  try { host = new URL(url).hostname; } catch { throw new Error(`refusing to run: "${url}" is not a URL`); }
  if (host !== `${ref}.supabase.co`) throw new Error(`refusing to run: ${host} is not the garden (${ref})`);
}
