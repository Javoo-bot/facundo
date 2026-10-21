import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Minimal/default config for staging. No incrementalCache override is
// passed, so @opennextjs/cloudflare falls back to its "dummy" (no-op) cache
// — appropriate here because every route in this app is
// `export const dynamic = "force-dynamic"` (no ISR/SSG pages to cache), and
// this POC deliberately introduces no new Cloudflare infra (no R2 bucket)
// beyond the existing Supabase project. Revisit if ISR is ever added.
//
// NOTE on the iCloud gotcha (see dashboard/CLAUDE.md): `buildOutputPath`
// looked like the obvious lever to redirect OpenNext's `.open-next` output
// into the already-`.nosync`-suffixed directory used elsewhere in this
// repo, but it also relocates where OpenNext expects to find the Next.js
// `.next` build output (`@opennextjs/aws`'s `normalizeOptions` derives both
// from the same `buildOutputPath` — it's meant for monorepo layouts, not
// this). Setting it broke the build with nested ENOENTs. Instead, the
// `cf:build` script in package.json runs the plain build (which recreates
// a real `.open-next` directory here every time — unavoidable, this is
// @opennextjs/aws's `initOutputDir()` behavior) and then, as a separate
// step, moves that output into `.open-next.nosync` and symlinks
// `.open-next` back to it, so the artifact is protected from iCloud
// eviction for however long it sits before `wrangler dev`/`deploy` reads
// it. See package.json and dashboard/DEPLOY.md for the residual risk this
// does NOT cover (the few seconds of the build itself, while OpenNext
// writes into the real, synced `.open-next`).
export default defineCloudflareConfig();
