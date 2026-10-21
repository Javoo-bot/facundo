// Next.js server instrumentation hook (root-level `instrumentation.ts`, next to
// next.config.mjs — same convention as the client-side `instrumentation-client.ts`). Next.js
// calls register() once per server instance, before any request is handled, so this is the one
// place to wire lib/monitor.ts's captureError() to PostHog — see lib/serverAnalytics.ts and its
// header comment for why the sink lives there instead of in monitor.ts itself.
export async function register() {
  const { installServerErrorSink } = await import("./lib/serverAnalytics");
  installServerErrorSink();
}
