/**
 * Linear → Spool relay. Inbound-only:
 *   inbound  : Linear webhook HTTP → Spool publish (ns=linear, type=webhook)
 *
 * Unlike AgentMail/Slack there is no consumer for Linear events. Webhooks
 * land in a Spool thread as an audit log Mega can read later (e.g. when
 * Haakam asks "what's been moving on Linear?"). The v1 per-webhook hygiene
 * Claude invocation is intentionally dropped — too eager and noisy.
 */

import { createHash, createHmac, timingSafeEqual } from "crypto";
import type { SpoolClient } from "../core/spool";
import type { RouteHandler } from "../core/http-server";

const webhookSecret = process.env.LINEAR_WEBHOOK_SECRET!;

/** Single flat thread for now — single-tenant. If Mega ever audits more
 *  than one Linear workspace, key by workspace id. */
export const LINEAR_HYGIENE_THREAD = "linear/hygiene";

export function verifySignature(body: string, signature: string): boolean {
  const hmac = createHmac("sha256", webhookSecret).update(body).digest("hex");
  try {
    return timingSafeEqual(
      Buffer.from(hmac, "utf-8"),
      Buffer.from(signature, "utf-8")
    );
  } catch {
    return false;
  }
}

export function isRelevantEvent(payload: any): boolean {
  const { action, type, data, updatedFrom } = payload;

  if (type === "Issue") {
    const stateName = data?.state?.name;
    const isTargetState =
      stateName === "In Progress" || stateName === "In Review";
    if (!isTargetState) return false;
    if (action === "create") return true;
    if (action === "update" && (updatedFrom?.stateId || updatedFrom?.state))
      return true;
    return false;
  }

  if (type === "Project") {
    const stateName = data?.state?.name;
    if (stateName !== "In Progress") return false;
    if (action === "create") return true;
    if (action === "update" && (updatedFrom?.stateId || updatedFrom?.state))
      return true;
    return false;
  }

  return false;
}

/** Spool-side dedup id. Linear webhooks don't carry an explicit delivery
 *  id, but each delivery body is unique (the timestamp differs per send).
 *  Hashing the raw body is the most robust choice: retries of the same
 *  delivery hash identically; distinct events hash differently. */
export function deriveDedupId(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

async function handleWebhook(
  req: Request,
  spool: SpoolClient
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const body = await req.text();
  const signature = req.headers.get("linear-signature") || "";

  if (!verifySignature(body, signature)) {
    console.error("[linear-spool] Invalid webhook signature");
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  if (!isRelevantEvent(payload)) {
    const t = payload.type ?? "unknown";
    const a = payload.action ?? "unknown";
    console.log(`[linear-spool] Skipping ${a} ${t} (not in scope)`);
    return new Response("OK", { status: 200 });
  }

  const identifier =
    payload.data?.identifier ??
    payload.data?.name ??
    payload.data?.id ??
    "unknown";
  const stateName = payload.data?.state?.name ?? "unknown";
  console.log(
    `[linear-spool] ${payload.action} ${payload.type} ${identifier} → ${stateName}`
  );

  try {
    await spool.publish(LINEAR_HYGIENE_THREAD, [
      {
        ns: "linear",
        type: "webhook",
        id: deriveDedupId(body),
        source: `linear.relay@${process.env.MEGA_DOMAIN ?? "india-desert.exe.xyz"}`,
        data: payload,
      },
    ]);
  } catch (e) {
    console.error("[linear-spool] publish failed:", e);
    return new Response("Internal Error", { status: 500 });
  }

  return new Response("OK", { status: 200 });
}

/** Side effect: kicks off thread creation (idempotent on Spool). Returns
 *  the route map for the shared HTTP server to register. */
export function routes(spool: SpoolClient): Record<string, RouteHandler> {
  void spool.createThread(LINEAR_HYGIENE_THREAD).catch((e) => {
    console.error(
      `[linear-spool] createThread(${LINEAR_HYGIENE_THREAD}) failed:`,
      e
    );
  });
  return {
    "/linear/webhook": (req) => handleWebhook(req, spool),
  };
}
