/**
 * Slack Events API webhook handler. Replaces (eventually) the Socket
 * Mode WebSocket inbound in `spool-relay.ts`.
 *
 * Slack signs each delivery with the app's Signing Secret:
 *   - x-slack-request-timestamp : unix seconds
 *   - x-slack-signature         : `v0=<hex HMAC-SHA256>` of
 *                                 `v0:${ts}:${raw-body}` keyed by the
 *                                 raw signing secret.
 *
 * Verification: timing-safe equality on the full signature string after
 * a 5-minute replay window check. The signing secret is a plain string
 * from the app dashboard (NOT base64 like Svix).
 *
 * Slack expects a 200 within 3 seconds or it retries. Event-callback
 * processing dispatches asynchronously so the HTTP response isn't
 * blocked on Spool publish or Slack API roundtrips.
 *
 * URL verification handshake: when the operator sets the Events API
 * Request URL in the Slack app config, Slack POSTs once with
 * `{type: "url_verification", challenge: "..."}`. We echo the challenge
 * back as plain text per Slack's recommended response form.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { SpoolClient } from "../core/spool";
import type { RouteHandler } from "../core/http-server";
import { handleSlackEvent } from "./spool-relay";

const signingSecret = process.env.SLACK_SIGNING_SECRET ?? "";

const TIMESTAMP_TOLERANCE_S = 5 * 60;

export function verifySlackSignature(
  body: string,
  headers: Headers,
  secret: string = signingSecret,
  nowMs: number = Date.now()
): boolean {
  if (!secret) return false;
  const ts = headers.get("x-slack-request-timestamp");
  const sig = headers.get("x-slack-signature");
  if (!ts || !sig) return false;

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(nowMs / 1000 - tsNum) > TIMESTAMP_TOLERANCE_S) return false;

  const baseStr = `v0:${ts}:${body}`;
  const expected =
    "v0=" + createHmac("sha256", secret).update(baseStr).digest("hex");

  // Constant-length-only constant-time compare — return false (not throw)
  // on length mismatch so a tampered signature looks identical to a
  // wrong-bytes signature from a timing perspective.
  if (sig.length !== expected.length) return false;
  return timingSafeEqual(
    Buffer.from(sig, "utf-8"),
    Buffer.from(expected, "utf-8")
  );
}

async function handleWebhook(
  req: Request,
  spool: SpoolClient
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const body = await req.text();

  if (!verifySlackSignature(body, req.headers)) {
    console.error("[slack-webhook] Invalid Slack signature");
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // One-time handshake when the operator sets the Events API URL.
  if (payload.type === "url_verification") {
    console.log("[slack-webhook] url_verification challenge");
    return new Response(payload.challenge ?? "", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (payload.type === "event_callback") {
    const evt = payload.event;
    console.log(
      `[slack-webhook] ${evt?.type ?? "?"} from ${evt?.user ?? "?"} in ${evt?.channel ?? "?"}`
    );
    // Slack's 3-second budget for the response. Dispatch the actual
    // work without awaiting so Spool/Slack-API latencies don't put us
    // over and trigger retries (which we'd dedup, but they're still
    // wasteful).
    void handleSlackEvent(spool, evt, payload.event_id);
    return new Response("OK", { status: 200 });
  }

  // Any other top-level type (rate_limit, etc.) — ack and ignore.
  return new Response("OK", { status: 200 });
}

export function routes(spool: SpoolClient): Record<string, RouteHandler> {
  return {
    "/slack/webhook": (req) => handleWebhook(req, spool),
  };
}
