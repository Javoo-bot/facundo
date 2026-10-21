// The dashboard's door into lib/langfuse.ts: names the agent by its registry id
// and reads LANGFUSE_* from process.env.
//
// On Cloudflare a fetch nobody awaits is cut when the response goes out, so a
// caller starts this as soon as the model has answered and awaits the promise
// before it returns. It never rejects.

import { agentSpec, type AgentId } from "./agents/registry.generated.ts";
import { langfuseConfig, sendAgentRun, type AgentRun } from "./langfuse.ts";

export type { Generation } from "./langfuse.ts";

export type DashboardRun = Omit<AgentRun, "agent"> & { agent: AgentId };

export async function traceAgentRun(run: DashboardRun, fetchImpl?: typeof fetch): Promise<string | null> {
  if (!langfuseConfig(process.env)) return null;
  return sendAgentRun(
    { ...run, agent: agentSpec(run.agent) },
    { env: process.env, service: "facundo-dashboard", fetchImpl },
  );
}
