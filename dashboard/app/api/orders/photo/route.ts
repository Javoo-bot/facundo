import { requireRole, jsonError } from "@/lib/apiAuth";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  const { searchParams } = new URL(request.url);
  const key = searchParams.get("key");
  if (!key || !key.startsWith("orders/") || key.includes("..")) {
    return jsonError("Invalid or missing key.", 400);
  }

  const { env } = getCloudflareContext();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- R2 binding untyped at build time (runtime provides env.PHOTOS)
  const obj = await (env as any).PHOTOS.get(key);
  if (!obj) return jsonError("Photo not found.", 404);

  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "image/jpeg",
      "Cache-Control": "private, max-age=300",
      "Content-Disposition": "inline",
    },
  });
}
