import { start as startAgentMail } from "./agentmail/channel";
import { start as startSlack } from "./slack/channel";

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
