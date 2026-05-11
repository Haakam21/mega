/**
 * AgentMail webhook handler (HTTP). Replaces the WebSocket-based
 * `startInbound` in `spool-relay.ts`.
 *
 * AgentMail delivers webhooks via Svix:
 *   - svix-id        : unique per delivery; same on retries (perfect dedup key)
 *   - svix-timestamp : unix seconds when sent (replay-attack window)
 *   - svix-signature : space-delimited `v1,<base64>` HMAC-SHA256 signatures
 *
 * Verification: HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${raw-body}`
 * keyed by the raw secret bytes (base64-decoded from `whsec_<base64>`).
 * Compare in constant time against each signature in the header.
 *
 * On success, publishes a `ns=agentmail, type=message` event to the
 * inbox's Spool thread — same shape as the old WebSocket inbound so the
 * consumer in `core/spool-loop.ts` doesn't need to change.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { SpoolClient } from "../core/spool";
import type { RouteHandler } from "../core/http-server";
import { inboxThread } from "./spool-relay";

const inboxId = process.env.AGENTMAIL_INBOX_ID!;
const webhookSecret = process.env.AGENTMAIL_WEBHOOK_SECRET ?? "";

/** Tolerance for clock drift between AgentMail and us. Svix's standard
 *  is 5 minutes; we match that. Beyond this window the request is
 *  rejected as a possible replay. */
const TIMESTAMP_TOLERANCE_S = 5 * 60;

/** Decodes a Svix `whsec_<base64>` secret into raw bytes. Throws on
 *  malformed input — caller is expected to validate the env var at boot. */
function decodeSecret(secret: string): Buffer {
  const b64 = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  return Buffer.from(b64, "base64");
}

export function verifySvixSignature(
  body: string,
  headers: Headers,
  secret: string = webhookSecret,
  nowMs: number = Date.now()
): boolean {
  if (!secret) return false;
  const id = headers.get("svix-id");
  const ts = headers.get("svix-timestamp");
  const sig = headers.get("svix-signature");
  if (!id || !ts || !sig) return false;

  // Replay window. `svix-timestamp` is unix seconds.
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  const drift = Math.abs(nowMs / 1000 - tsNum);
  if (drift > TIMESTAMP_TOLERANCE_S) return false;

  const signedPayload = `${id}.${ts}.${body}`;
  const expected = createHmac("sha256", decodeSecret(secret))
    .update(signedPayload)
    .digest("base64");
  const expectedBuf = Buffer.from(expected, "utf-8");

  // Header is one or more space-separated `v1,<base64>` entries. We
  // accept on the first match. Constant-time compare per entry guards
  // against timing leaks on the signature itself.
  for (const part of sig.split(" ")) {
    const comma = part.indexOf(",");
    if (comma < 0) continue;
    const version = part.slice(0, comma);
    if (version !== "v1") continue;
    const candidate = Buffer.from(part.slice(comma + 1), "utf-8");
    if (candidate.length !== expectedBuf.length) continue;
    if (timingSafeEqual(candidate, expectedBuf)) return true;
  }
  return false;
}

async function handleWebhook(
  req: Request,
  spool: SpoolClient
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const body = await req.text();

  if (!verifySvixSignature(body, req.headers)) {
    console.error("[agentmail-webhook] Invalid Svix signature");
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const evType = payload.event_type;
  if (
    evType !== "message.received" &&
    evType !== "message.received.spam"
  ) {
    // The webhook is registered with a narrow event_type filter, but
    // skip-and-200 anything unexpected so AgentMail doesn't retry.
    return new Response("OK", { status: 200 });
  }

  const message = payload.message ?? {};

  try {
    await spool.publish(inboxThread(), [
      {
        ns: "agentmail",
        type: "message",
        // Use AgentMail's event_id (same field the WebSocket relay used)
        // so the two transports dedup against each other server-side
        // during the migration window. svix-id alone would be different
        // per transport for the same email.
        id: payload.event_id,
        source: `agentmail.relay@${process.env.MEGA_DOMAIN ?? "india-desert.exe.xyz"}`,
        data: {
          event_id: payload.event_id,
          inbox_id: inboxId,
          thread_id: message.thread_id,
          message_id: message.message_id,
          from: message.from_,
          to: message.to,
          subject: message.subject,
          text: message.extracted_text || message.text || "",
        },
      },
    ]);
  } catch (e) {
    console.error("[agentmail-webhook] publish failed:", e);
    return new Response("Internal Error", { status: 500 });
  }

  console.log(
    `[agentmail-webhook] ${evType} from ${message.from_} (thread=${message.thread_id})`
  );
  return new Response("OK", { status: 200 });
}

export function routes(spool: SpoolClient): Record<string, RouteHandler> {
  return {
    "/agentmail/webhook": (req) => handleWebhook(req, spool),
  };
}
