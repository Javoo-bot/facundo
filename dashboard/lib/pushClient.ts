"use client";

/** Converts the URL-safe base64 VAPID public key (as generated/stored in env)
 * into the raw byte array `PushManager.subscribe` expects. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64Safe);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

/** Shared subscribe flow: requests notification permission, subscribes this
 * device via the SW's PushManager, and POSTs the subscription to `endpoint`.
 * Best-effort from the caller's perspective — every failure mode (unsupported
 * browser, blocked permission, subscribe/POST failure) returns a
 * discriminated result rather than throwing, so the UI can show an inline
 * message. */
async function subscribeAndRegister(endpoint: string): Promise<{ ok: boolean; error?: string }> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return { ok: false, error: "Push notifications aren't supported on this device/browser." };
  }

  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!publicKey) return { ok: false, error: "Push isn't configured." };

  const perm = await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, error: "Notifications blocked" };

  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });
    if (!res.ok) return { ok: false, error: "Could not save subscription." };

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Subscribe failed." };
  }
}

/** Subscribes the current device to web push and registers the subscription
 * with the server (`/api/florist/push-subscribe`, florist-gated). */
export async function enablePush(): Promise<{ ok: boolean; error?: string }> {
  return subscribeAndRegister("/api/florist/push-subscribe");
}

/** Subscribes the current device to web push for staff CX alerts
 * (`/api/staff/push-subscribe`, allow-list gated) — dashboard/lib/cxAlerts.ts
 * pages this device when SLA-breaching CX work goes unattended. */
export async function enableStaffPush(): Promise<{ ok: boolean; error?: string }> {
  return subscribeAndRegister("/api/staff/push-subscribe");
}
