import { start as startAgentMail } from "./agentmail/channel";
import { start as startSlack } from "./slack/channel";
import { startWatchdog } from "./core/watchdog";
import { startLogRotator } from "./core/log-rotator";

console.log("Mega agent harness starting...");

const channels: string[] = [];

if (process.env.AGENTMAIL_API_KEY && process.env.AGENTMAIL_INBOX_ID) {
  startAgentMail();
  channels.push("agentmail");
}

if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
  startSlack();
  channels.push("slack");
}

if (channels.length === 0) {
  console.error("No channels configured. Set env vars in .env");
  process.exit(1);
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
