import { startWatchdog } from "./core/watchdog";
import { startLogRotator } from "./core/log-rotator";
import { SpoolClient } from "./core/spool";
import { startAgentMailV2, startSlackV2 } from "./core/spool-loop";
import { slackThread as slackSpoolThread } from "./slack/spool-relay";
import { routes as slackWebhookRoutes } from "./slack/webhook";
import { routes as linearWebhookRoutes } from "./linear/spool-relay";
import { startHttpServer, type RouteHandler } from "./core/http-server";

console.log("Mega agent harness starting...");

const channels: string[] = [];
const domain = process.env.MEGA_DOMAIN ?? "india-desert.exe.xyz";
const spoolUrl = process.env.MEGA_SPOOL_URL ?? "https://spool.computer";

const spool = new SpoolClient(spoolUrl, `mega@${domain}`);
console.log(`[mega] spool=${spoolUrl} as mega@${domain}`);

const httpRoutes: Record<string, RouteHandler> = {};

// AgentMail is now brokered by fabric. Mega doesn't receive AgentMail
// webhooks directly anymore — fabric does, and publishes per-email-thread
// fork events into MEGA_AGENTMAIL_PARENT. Mega's consumer tails that
// parent's thread.forked events and spawns one Claude session per fork.
// Outbound `message.end` events fabric tails and dispatches to AgentMail's
// reply API.
const agentmailParent = process.env.MEGA_AGENTMAIL_PARENT;
if (agentmailParent) {
  void startAgentMailV2(spool, agentmailParent);
  channels.push("agentmail");
}

if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET) {
  // Slack inbound arrives via the Events API webhook at /slack/webhook.
  // The bot token authorizes outbound chat.postMessage + reactions +
  // conversations.replies; the signing secret authenticates incoming
  // deliveries.
  void (async () => {
    const parent = await slackSpoolThread();
    await startSlackV2(spool, parent);
  })();
  Object.assign(httpRoutes, slackWebhookRoutes(spool));
  channels.push("slack");
}

if (process.env.LINEAR_WEBHOOK_SECRET) {
  Object.assign(httpRoutes, linearWebhookRoutes(spool));
  channels.push("linear");
}

if (channels.length === 0) {
  console.error("No channels configured. Set env vars in .env");
  process.exit(1);
}

if (Object.keys(httpRoutes).length > 0) {
  startHttpServer(httpRoutes);
}

console.log(`Active channels: ${channels.join(", ")}`);

// Belt-and-suspenders for the runaway-process fix set: count claude
// processes periodically and warn if a leak slips through every other
// defense layer.
startWatchdog();

// Bound harness.log so a long-uptime host doesn't run out of disk waiting
// for `make stop`. Truncate-in-place every minute when over the cap;
// `make start`'s O_APPEND redirect makes the truncate actually free disk.
startLogRotator();
