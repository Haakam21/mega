import { start as startAgentMail } from "./agentmail/channel";
import { start as startSlack } from "./slack/channel";
import { start as startLinear } from "./linear/channel";
import { startWatchdog } from "./core/watchdog";
import { startLogRotator } from "./core/log-rotator";
import { SpoolClient } from "./core/spool";
import { startAgentMailConsumer } from "./core/spool-loop";
import {
  inboxThread as agentmailInboxThread,
  startInbound as startAgentMailInbound,
  startOutbound as startAgentMailOutbound,
} from "./agentmail/spool-relay";

console.log("Mega agent harness starting...");

const channels: string[] = [];

const useSpool = process.env.MEGA_USE_SPOOL === "true";
const domain = process.env.MEGA_DOMAIN ?? "india-desert.exe.xyz";
const spoolUrl = process.env.MEGA_SPOOL_URL ?? "https://spool.computer";

if (useSpool) {
  // Spool is the I/O substrate: each third-party channel runs as a
  // bidirectional relay (events ↔ Spool thread); Mega's consumer loop
  // tails cursors and invokes Claude. Direct channels stay disabled
  // when MEGA_USE_SPOOL=true to avoid double-processing.
  const spool = new SpoolClient(spoolUrl, `mega@${domain}`);
  console.log(`[mega] spool=${spoolUrl} as mega@${domain}`);

  if (process.env.AGENTMAIL_API_KEY && process.env.AGENTMAIL_INBOX_ID) {
    startAgentMailInbound(spool);
    void startAgentMailOutbound(spool);
    void startAgentMailConsumer(
      spool,
      agentmailInboxThread(),
      "mega-agentmail"
    );
    channels.push("agentmail-spool");
  }
} else {
  if (process.env.AGENTMAIL_API_KEY && process.env.AGENTMAIL_INBOX_ID) {
    startAgentMail();
    channels.push("agentmail");
  }

  if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    startSlack();
    channels.push("slack");
  }

  if (process.env.LINEAR_WEBHOOK_SECRET) {
    startLinear();
    channels.push("linear");
  }
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
