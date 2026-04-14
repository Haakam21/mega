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
make start    # Start the agent (tree-kills any existing instances first)
make stop     # Stop the agent (tree-kills the whole process group,
              # including any in-flight Claude subprocesses)
make status   # Show agent status
```

`make stop` signals the harness's process group, so Claude invocations and their tool subprocesses are reaped together. Every invocation also has a wall-clock timeout (default 5 min, override with `MEGA_INVOKE_TIMEOUT_MS`) that tree-kills on expiry. See `CLAUDE.md` → "Process Safety" for the full story.

## Dependencies

- [Claude Code](https://claude.ai/code) — the agent
- [Bun](https://bun.sh) — TypeScript runtime, WebSocket client, test runner
- [gh](https://cli.github.com) — GitHub CLI for PR review
- [jq](https://jqlang.github.io/jq/) — checked by `make setup` (legacy dep)
- [memfs](https://github.com/Haakam21/mem-fs) — shared memory across instances

`make setup` verifies each of these before running any configuration steps.

## Configuration

All secrets live in `.env` (gitignored). `MEMFS_*` and `GITHUB_TOKEN` are required. At least one channel (AgentMail or Slack) must be configured; each is independently optional:

```
# Required
MEMFS_SYNC_URL=         # Turso database URL for memory sync
MEMFS_SYNC_TOKEN=       # Turso auth token
GITHUB_TOKEN=           # GitHub PAT for code review

# AgentMail (optional — leave blank to disable)
AGENTMAIL_API_KEY=      # AgentMail API key
AGENTMAIL_INBOX_ID=     # Agent's email address (e.g., name@agentmail.to)

# Slack (optional — leave blank to disable)
SLACK_BOT_TOKEN=        # xoxb-... Bot User OAuth Token
SLACK_APP_TOKEN=        # xapp-... App-Level Token with connections:write
```

## Architecture

Bun/TypeScript harness (`index.ts`) starts whichever channels are configured. Each channel opens a WebSocket, dedupes events, invokes Claude Code with full tool access and session continuity, then sends the response back via its own API.

```
Event (email/DM/mention) → channel WebSocket → core/invoke.ts → claude --print → reply sent
```

- `agentmail/channel.ts` — AgentMail WebSocket subscriber + reply sender
- `slack/channel.ts` — Slack Socket Mode subscriber + reply sender
- `core/invoke.ts` — Shared: dedup, invoke Claude, return response
- `core/websocket.ts` — Shared: reconnecting WebSocket client

See `CLAUDE.md` for the full project structure and channel details.

## Testing

```bash
make test        # unit + E2E
make test-unit   # unit tests only
make test-e2e    # E2E (AgentMail test auto-skips if AGENTMAIL_API_KEY is blank)
```
