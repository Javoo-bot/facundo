import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

/** @type {import('next').NextConfig} */
const nextConfig = {};

// Wire the Cloudflare bindings (R2 `PHOTOS`, etc. from wrangler.jsonc) into
// `next dev` via miniflare, so getCloudflareContext() works locally — otherwise
// the R2-backed photo upload/read routes 500 in dev.
//
// `remoteBindings: true` makes bindings marked `"remote": true` in wrangler.jsonc
// (the PHOTOS bucket) proxy to the REAL Cloudflare resource in local dev instead
// of a per-checkout miniflare copy — so delivery photos are the same bucket as
// staging/v2 (and consistent with the shared Supabase DB). Requires Cloudflare
// auth locally (`wrangler login` or CLOUDFLARE_API_TOKEN); everything else still
// runs locally. Deploys are unaffected — deployed workers always use the real bucket.
//
// IMPORTANT: only run this dev hook in `next dev`. During the CI build
// (`opennextjs-cloudflare build` → `next build`, NODE_ENV=production) it must NOT
// fire — `remoteBindings: true` tries to open a remote Cloudflare session, and the
// build step has no CLOUDFLARE_API_TOKEN, so it crashes the build. The hook is
// dev-only anyway (OpenNext resolves real bindings itself at build/deploy time).
//
// Escape hatch: set OPENNEXT_REMOTE_BINDINGS=0 in .env.local to use a LOCAL
// miniflare copy of the bindings instead — no Cloudflare login needed. Photo
// upload/read then works against a throwaway local bucket; everything else
// (Supabase, Resend, the order/recruiting loops) is unaffected. For dev work
// that never touches delivery photos (e.g. QA against staging Supabase).
if (process.env.NODE_ENV === "development") {
  initOpenNextCloudflareForDev({ remoteBindings: process.env.OPENNEXT_REMOTE_BINDINGS !== "0" });
}

export default nextConfig;
