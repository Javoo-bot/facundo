// The garden's Resend path: the shared sender onboarding@resend.dev, which may
// only mail the account owner's inbox (docs/agent-factory/garden-deploy.md).

import { OPERATOR_INBOX, type Env } from "./garden";

export async function mailOperator(env: Env, subject: string, text: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: "Facundo garden <onboarding@resend.dev>", to: [OPERATOR_INBOX], subject, text }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
