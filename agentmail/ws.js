// Connects to AgentMail WebSocket and prints events to stdout (one JSON per line).
// Usage: node ws.js <api_key> <inbox_id>

const apiKey = process.argv[2];
const inboxId = process.argv[3];

if (!apiKey || !inboxId) {
  process.stderr.write("Usage: node ws.js <api_key> <inbox_id>\n");
  process.exit(1);
}

const url = `wss://ws.agentmail.to/v0?api_key=${apiKey}`;

function connect() {
  const ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({
      type: "subscribe",
      inbox_ids: [inboxId],
      event_types: ["message.received", "message.received.spam"],
    }));
  });

  ws.addEventListener("message", (event) => {
    process.stdout.write(event.data + "\n");
  });

  ws.addEventListener("close", () => {
    process.stderr.write("WebSocket closed. Reconnecting in 5s...\n");
    setTimeout(connect, 5000);
  });

  ws.addEventListener("error", (err) => {
    process.stderr.write(`WebSocket error: ${err.message}\n`);
  });
}

connect();
