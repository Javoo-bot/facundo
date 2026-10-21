import { createClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client — bypasses RLS. SERVER-ONLY: this module must
 * never be imported by a client component. Use ONLY inside auth-gated API
 * routes for the narrow set of writes the dashboard performs (florist
 * exclude, and future outreach records). Reads stay on the anon key + JWT.
 *
 * Deliberately kept out of lib/supabase.ts (which the client bundle imports)
 * so the service-role key can never end up in client-shipped code.
 */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}
