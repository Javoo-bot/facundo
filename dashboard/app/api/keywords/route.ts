import { spawn } from "node:child_process";
import path from "node:path";
import { isAllowed, getStaffRole } from "@/lib/allowlist";
import { createServerClient } from "@/lib/supabase";

// Spawns a real OS process — must run on the Node runtime, never Edge.
export const runtime = "nodejs";
// Validates a session and spawns a process on every call; never let Next.js
// statically optimize or cache it.
export const dynamic = "force-dynamic";

// Cache-first lookup (see ingest/derive_keywords.py) — much shorter than
// ingest's 8-minute budget.
const MAX_DURATION_MS = 30 * 1000; // 30 seconds
const MAX_STRING_LEN = 100; // mirrors app/api/ingest/route.ts's country/city cap
const MAX_STDERR_TAIL = 2000; // don't leak unbounded process output into the response

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface KeywordsRequestBody {
  country: string;
}

function parseAndValidate(
  body: unknown
): { ok: true; value: KeywordsRequestBody } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "Request body must be a JSON object." };
  }
  const { country } = body as Record<string, unknown>;

  if (typeof country !== "string") {
    return { ok: false, message: "country must be a string." };
  }
  const trimmedCountry = country.trim();
  if (!trimmedCountry) {
    return { ok: false, message: "country must not be empty." };
  }
  if (trimmedCountry.length > MAX_STRING_LEN) {
    return { ok: false, message: `country must be at most ${MAX_STRING_LEN} characters.` };
  }

  return { ok: true, value: { country: trimmedCountry } };
}

interface KeywordsResponseBody {
  keywords: string[];
  language: string;
}

/** Type guard for derive_keywords.py's expected stdout shape — never trust
 * a spawned process's output blindly. */
function isKeywordsResponseBody(value: unknown): value is KeywordsResponseBody {
  if (typeof value !== "object" || value === null) return false;
  const { keywords, language } = value as Record<string, unknown>;
  return (
    Array.isArray(keywords) &&
    keywords.every((k) => typeof k === "string") &&
    typeof language === "string"
  );
}

export async function POST(request: Request): Promise<Response> {
  // DEPLOYMENT GATE — derive_keywords.py (spawned below) only exists next
  // to the local Python ingest CLI, not in the Cloudflare Workers deployment.
  // INGEST_MODE=queue is set there (see wrangler.jsonc / dashboard/DEPLOY.md)
  // so this route fails fast instead of spawning. In queue mode the dashboard
  // never calls this route (RerunCityButton / AddCityForm skip the keyword
  // prefetch and let the Mac-mini CLI derive keywords); the 503 is just a
  // belt-and-suspenders guard. Unset (local dev) leaves behavior unchanged.
  if (process.env.INGEST_MODE === "queue") {
    return jsonError("Keyword derivation runs on the Mac mini — not available on this deployment.", 503);
  }

  // AUTH GATE — same pattern as app/api/ingest/route.ts: only allow-listed,
  // signed-in users may spend the Claude credits behind a cache miss.
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return jsonError("Not signed in.", 401);
  }
  if (!(await isAllowed(user.email))) {
    return jsonError("This account is not authorized to look up keywords.", 403);
  }
  const role = await getStaffRole(user.email);
  if (!role || !["ops", "admin"].includes(role)) {
    return jsonError("Your role doesn't allow this.", 403);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const parsed = parseAndValidate(rawBody);
  if (!parsed.ok) {
    return jsonError(parsed.message, 400);
  }
  const { country } = parsed.value;

  // dashboard/ and ingest/ are sibling directories; process.cwd() for a
  // Next.js server process is the dashboard/ package root. Identical
  // resolution to app/api/ingest/route.ts.
  const ingestCwd = path.resolve(process.cwd(), "..", "ingest");

  return new Promise<Response>((resolve) => {
    let settled = false;
    const settle = (response: Response) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };

    // Arg array + shell:false — no shell interpolation of the user-supplied
    // country string, so there's no command-injection surface even though
    // the value is already validated above.
    const child = spawn("uv", ["run", "python", "derive_keywords.py", "--country", country], {
      cwd: ingestCwd,
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    const timeoutHandle = setTimeout(() => {
      child.kill("SIGKILL");
      settle(jsonError("Keyword lookup timed out after 30 seconds.", 500));
    }, MAX_DURATION_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timeoutHandle);
      settle(jsonError(`Failed to start keyword lookup: ${err.message}`, 500));
    });

    child.on("close", (code) => {
      clearTimeout(timeoutHandle);

      if (code !== 0) {
        const tail = stderr.trim().slice(-MAX_STDERR_TAIL);
        settle(
          jsonError(
            `derive_keywords.py exited with code ${code ?? "unknown"}.${tail ? ` stderr: ${tail}` : ""}`,
            500
          )
        );
        return;
      }

      let parsedOutput: unknown;
      try {
        parsedOutput = JSON.parse(stdout);
      } catch {
        settle(jsonError("Unexpected output from derive_keywords.py (invalid JSON).", 500));
        return;
      }

      if (!isKeywordsResponseBody(parsedOutput)) {
        settle(jsonError("Unexpected output from derive_keywords.py (unexpected shape).", 500));
        return;
      }

      settle(
        new Response(JSON.stringify(parsedOutput), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    });

    // Client navigated away / aborted the fetch — kill the child rather than
    // let it run to completion unattended.
    request.signal.addEventListener("abort", () => {
      clearTimeout(timeoutHandle);
      child.kill("SIGTERM");
      settle(jsonError("Request aborted.", 500));
    });
  });
}
