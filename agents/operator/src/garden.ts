// Garden only, hard. Every entry point calls gardenEnv() first, and it throws
// unless every outward address is the garden's: the side-project database, the
// garden dashboard, and the one inbox Resend may mail. A production key pasted
// here by mistake reaches nothing.

export const GARDEN_DB_HOST = "your-project-ref.supabase.co";
export const GARDEN_DASHBOARD = "https://facundo-dashboard-garden.your-subdomain.workers.dev";
export const OPERATOR_INBOX = "owner@example.com";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_ANON_KEY: string;
  DASHBOARD_URL: string;
  OPERATOR_EMAIL: string;
  OPERATOR_PASSWORD: string;
  OPERATOR_PASSPHRASE: string;
  RESEND_API_KEY: string;
  DIGEST_TO: string;
  OAUTH_KV: KVNamespace;
}

export function gardenEnv(env: Env): Env {
  const missing = (
    ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "DASHBOARD_URL", "OPERATOR_EMAIL", "OPERATOR_PASSWORD"] as const
  ).filter((k) => !env[k]);
  if (missing.length) throw new Error(`refusing: missing ${missing.join(", ")}`);
  const db = new URL(env.SUPABASE_URL).hostname;
  if (db !== GARDEN_DB_HOST) throw new Error(`refusing: ${db} is not the garden database`);
  if (new URL(env.DASHBOARD_URL).origin !== GARDEN_DASHBOARD) throw new Error(`refusing: ${env.DASHBOARD_URL} is not the garden dashboard`);
  if (env.DIGEST_TO && env.DIGEST_TO !== OPERATOR_INBOX) throw new Error(`refusing: the digest only goes to ${OPERATOR_INBOX}`);
  return env;
}
