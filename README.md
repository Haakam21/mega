# Mega

A portable agent image that runs a digital clone of Haakam Aujla. Clone the repo, configure `.env`, run `make setup`, and the agent handles email as Haakam.

## How it works

Claude Code is the agent. Everything else is scaffolding:

- **AgentMail WebSocket** delivers email events in real-time
- **Claude Code** processes each email and generates a reply
- **memfs** syncs memory across all agent instances

Each email thread maps to a Claude Code session, so conversations maintain full context.

## Quick start

```bash
git clone <repo-url> mega && cd mega
cp .env.example .env    # Fill in credentials
make setup              # Install deps, configure memfs
make start              # Start the email listener
```

## Commands

```bash
make setup    # First-time setup (deps, memfs, env validation)
make start    # Start the agent (kills any existing instances first)
make stop     # Stop the agent
make status   # Show agent status
```

## Dependencies

- [Claude Code](https://claude.ai/code) — the agent
- [Node.js](https://nodejs.org) — WebSocket client
- [jq](https://jqlang.github.io/jq/) — JSON parsing
- [curl](https://curl.se) — HTTP requests
- [memfs](https://memfs.io) — shared memory across instances

## Configuration

All secrets live in `.env` (gitignored):

```
MEMFS_SYNC_URL=         # Turso database URL for memory sync
MEMFS_SYNC_TOKEN=       # Turso auth token
AGENTMAIL_API_KEY=      # AgentMail API key
AGENTMAIL_INBOX_ID=     # Agent's email address (e.g., name@agentmail.to)
```

## Architecture

```
Email arrives → AgentMail WebSocket → ws.js → listener.sh → claude --print → reply sent
```

- `agentmail/ws.js` — Node.js WebSocket client, prints events to stdout
- `agentmail/listener.sh` — Reads events, invokes Claude Code, sends replies
- `agentmail/test.sh` — End-to-end test (sends email, verifies reply + session continuity)

## Testing

```bash
bash agentmail/test.sh
```

Sends a test email, invokes Claude, verifies the reply, then sends a follow-up to confirm session continuity.
