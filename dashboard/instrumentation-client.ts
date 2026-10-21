// PostHog init. Next.js runs this file (root-level `instrumentation-client.ts`,
// next to next.config.mjs — NOT under app/) in the browser before the app
// hydrates, which is why there's no provider/context here: posthog-js is a
// singleton module, so lib/analytics.ts can just import it. Matches PostHog's
// current App Router guidance and this codebase's zero-context convention.
//
// Client-only: this never enters the OpenNext worker bundle.
import posthog from "posthog-js";

// Module-level reads, per the NEXT_PUBLIC_* convention (lib/supabase.ts,
// lib/push.ts). These are inlined by `next build` — see the deploy note below.
const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://eu.i.posthog.com";
// The garden build sets "garden" (deploy-garden.yml); it shares production's project.
const posthogEnvironment = process.env.NEXT_PUBLIC_POSTHOG_ENVIRONMENT || "production";

// No key → no-op. Keeps local dev (no .env.local entry) and any keyless build
// silent rather than throwing on every page load.
//
// DEPLOY: the key is inlined at BUILD time, so PostHog cannot be switched on at
// runtime via `wrangler secret put` — an environment built without the key has no
// analytics until it's rebuilt. The off switch is the reverse: the project's
// "Record user sessions" toggle in PostHog stops recording with no redeploy.
if (posthogKey) {
  posthog.init(posthogKey, {
    api_host: posthogHost,
    // Pins the behavior set documented at the time of writing. Most relevant
    // here: `capture_pageview: 'history_change'` (App Router does client-side
    // nav, so without it we'd only see pageviews on hard loads) and
    // `external_scripts_inject_target: 'head'` (avoids SSR hydration errors
    // when the replay recorder is lazy-loaded).
    defaults: "2026-05-30",
    // Session replay ALSO requires the "Record user sessions" toggle in PostHog
    // project settings. Without it: init succeeds, events flow, and zero
    // recordings are produced — with no error. See DEPLOY.md.
    //
    // Masking is left at PostHog's default: input values are masked (passwords
    // always, regardless), but rendered TEXT is readable in recordings. That is
    // a deliberate, informed tradeoff — it means customer names, addresses and
    // card messages on /orders and /cx, and payout figures on the florist
    // pages, land in PostHog EU as readable text. To tighten it later, add a
    // `session_recording: { maskTextSelector: "*" }` here (global) or mark
    // individual elements with `.ph-no-capture` — neither needs a refactor.
    //
    // Error tracking stays with lib/monitor.ts::captureError (whose stated plan
    // is Sentry). Leaving PostHog's exception autocapture on would quietly
    // stand up a second, half-owned error pipeline.
    capture_exceptions: false,
    // Replay starts OFF and is armed later by lib/analytics.ts::identifyUser,
    // which is the first point where the signed-in user is known. Recording
    // from here instead would capture the opening seconds of an excluded
    // internal user's session before we could stop it. identifyUser() calls
    // startSessionRecording(), which clears this flag via set_config.
    // Events/pageviews are unaffected — only the recording waits.
    disable_session_recording: true,
    // Stamped on every event here rather than posthog.register(): reset() on sign-out
    // wipes registered super properties, this hook it cannot.
    before_send: (event) => {
      if (event) event.properties = { ...event.properties, environment: posthogEnvironment };
      return event;
    },
  });
}
