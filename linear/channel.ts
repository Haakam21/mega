import { createHmac, timingSafeEqual } from "crypto";
import { invoke } from "../core/invoke";
import { parsePositiveInt } from "../core/env";

const webhookSecret = process.env.LINEAR_WEBHOOK_SECRET!;
const DEFAULT_PORT = 8000;

const SYSTEM_PROMPT = `You are processing a Linear webhook event. Analyze the issue or project against the team's hygiene rules and notify Haakam on Slack if there are violations.

## Hygiene Rules

**Issues (In Progress / In Review) must have:**
- Priority set
- Assignee
- At least one codebase label (API, Console, Landing, Docs, MCP, SDKs, SMTP, Toolkit)
- Estimate (story points)
- Should be part of a project unless there's a good reason

**Projects (In Progress) must have:**
- Lead/assignee
- Description (not empty)
- Target date

## What to do

1. Use the Linear tools to fetch the full details of the issue or project from the webhook event
2. Check it against the hygiene rules — use judgment, not just mechanical checks
3. If there are violations, send Haakam a Slack DM (channel D0AS9T5CP4K) describing what's missing and proposing what action to take (e.g., "DM harry to add codebase labels to ENG-361")
4. Do NOT take action on the issues yourself — only notify Haakam and wait for his approval via Slack
5. If everything looks clean, do not notify — only flag genuine gaps

Keep messages short and direct. Include Linear issue links.`;

function verifySignature(body: string, signature: string): boolean {
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

function isRelevantEvent(payload: any): boolean {
  const { action, type, data, updatedFrom } = payload;

  if (type === "Issue") {
    const stateName = data?.state?.name;
    const isTargetState =
      stateName === "In Progress" || stateName === "In Review";
    if (!isTargetState) return false;

    // Created directly in a target state
    if (action === "create") return true;

    // Status just changed to a target state
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

export function start() {
  const port = parsePositiveInt("MEGA_LINEAR_PORT", DEFAULT_PORT);

  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // Health check
      if (req.method === "GET" && url.pathname === "/health") {
        return new Response("ok", { status: 200 });
      }

      if (req.method !== "POST" || url.pathname !== "/linear/webhook") {
        return new Response("Not Found", { status: 404 });
      }

      const body = await req.text();
      const signature = req.headers.get("linear-signature") || "";

      if (!verifySignature(body, signature)) {
        console.error("[linear] Invalid webhook signature");
        return new Response("Unauthorized", { status: 401 });
      }

      let payload: any;
      try {
        payload = JSON.parse(body);
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      if (isRelevantEvent(payload)) {
        const identifier =
          payload.data?.identifier ||
          payload.data?.name ||
          payload.data?.id ||
          "unknown";
        console.log(
          `[linear] ${payload.action} ${payload.type} ${identifier} → ${payload.data?.state?.name}`
        );

        // Fire-and-forget: Claude uses tools to notify Haakam on Slack.
        // Response is unused — this channel has no reply path.
        invoke({
          eventId: `linear-${payload.type}-${payload.data?.id}-${payload.createdAt}`,
          sessionId: `linear-${identifier}`,
          prompt: `Linear webhook: ${payload.type} "${identifier}" was ${payload.action}d and is now "${payload.data?.state?.name}".\n\nFetch the full details using Linear tools and check hygiene.\n\nRaw event:\n${JSON.stringify(payload, null, 2)}`,
          systemPrompt: SYSTEM_PROMPT,
        }).catch((err) => {
          console.error("[linear] Invoke error:", err);
        });
      } else {
        const type = payload.type || "unknown";
        const action = payload.action || "unknown";
        console.log(`[linear] Skipping ${action} ${type} (not in scope)`);
      }

      return new Response("OK", { status: 200 });
    },
  });

  console.log(`[linear] Webhook server listening on port ${port}`);
}
