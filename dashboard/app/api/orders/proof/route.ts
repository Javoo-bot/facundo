import { getCloudflareContext } from "@opennextjs/cloudflare";
import { verifyProofToken } from "@/lib/photoToken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PUBLIC, token-gated delivery-proof photo — the customer has no login, so the
// "delivered" email links here with a signed, expiring token (see lib/photoToken).
// Only ever serves a `delivered-` proof key, and only with a valid signature, so
// it can't be used to enumerate other stored objects.
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get("key");
  const exp = Number(searchParams.get("exp"));
  const sig = searchParams.get("sig");

  if (!key || !key.startsWith("orders/") || key.includes("..") || !key.includes("/delivered-")) {
    return new Response("bad request", { status: 400 });
  }
  if (!sig || !verifyProofToken(key, exp, sig)) {
    return new Response("forbidden", { status: 403 });
  }

  const { env } = getCloudflareContext();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- R2 binding untyped at build time (runtime provides env.PHOTOS)
  const obj = await (env as any).PHOTOS.get(key);
  if (!obj) return new Response("not found", { status: 404 });

  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "image/jpeg",
      "Cache-Control": "public, max-age=86400",
      "Content-Disposition": "inline",
    },
  });
}
