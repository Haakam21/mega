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
import { parsePositiveInt } from "../core/env";

const webhookSecret = process.env.LINEAR_WEBHOOK_SECRET!;
const DEFAULT_PORT = 8000;

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

export function start(spool: SpoolClient): void {
  const port = parsePositiveInt("MEGA_LINEAR_PORT", DEFAULT_PORT);
  const thread = LINEAR_HYGIENE_THREAD;

  void spool.createThread(thread).catch((e) => {
    console.error(`[linear-spool] createThread(${thread}) failed:`, e);
  });

  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/health") {
        return new Response("ok", { status: 200 });
      }

      if (req.method !== "POST" || url.pathname !== "/linear/webhook") {
        return new Response("Not Found", { status: 404 });
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
        await spool.publish(thread, [
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
    },
  });

  console.log(
    `[linear-spool] Webhook server listening on port ${port}, thread=${thread}`
  );
}
