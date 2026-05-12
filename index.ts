import { startWatchdog } from "./core/watchdog";
import { startLogRotator } from "./core/log-rotator";
import { SpoolClient } from "./fabric/packages/consumer-sdk/src";
import { startAgentMail, startSlack } from "./core/spool-loop";
import { routes as linearWebhookRoutes } from "./linear/spool-relay";
import { startHttpServer, type RouteHandler } from "./core/http-server";

console.log("Mega agent harness starting...");

const channels: string[] = [];
const domain = process.env.MEGA_DOMAIN ?? "india-desert.exe.xyz";
const spoolUrl = process.env.MEGA_SPOOL_URL ?? "https://spool.computer";

const spool = new SpoolClient(spoolUrl, `mega@${domain}`);
console.log(`[mega] spool=${spoolUrl} as mega@${domain}`);

const httpRoutes: Record<string, RouteHandler> = {};

// AgentMail + Slack are brokered by fabric (fabric.delivery). Mega owns
// neither inbound webhooks nor outbound reply paths for those channels.
// Fabric publishes per-conversation forks into the configured parent
// thread; Mega's discovery cursor spawns one Claude session per fork.
// Outbound `message.end` events fabric tails and dispatches.

const agentmailParent = process.env.MEGA_AGENTMAIL_PARENT;
if (agentmailParent) {
  void startAgentMail(spool, agentmailParent);
  channels.push("agentmail");
}

const slackParent = process.env.MEGA_SLACK_PARENT;
if (slackParent) {
  void startSlack(spool, slackParent);
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
