// Garden database access for score.mjs, daily-report.mjs and tone/pick.mjs: Supabase REST with the
// service-role key. Refuses any database but the side project, so a production key pasted by
// mistake reads and writes nothing.
//
// Env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.

export const GARDEN_HOST = 'your-project-ref.supabase.co';

export function gardenDb(env = process.env) {
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  if (new URL(url).hostname !== GARDEN_HOST) throw new Error(`refusing: ${new URL(url).hostname} is not the garden database (${GARDEN_HOST})`);
  const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  return async function rest(path, { method = 'GET', body, prefer } = {}) {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      method,
      headers: prefer ? { ...headers, prefer } : headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path.split('?')[0]}: ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
}

export function madridDate(at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(at);
}

export function argValue(name, argv = process.argv) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}
