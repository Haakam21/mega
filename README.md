# Mega

A portable agent image that runs a digital clone of Haakam Aujla. Clone the repo, configure `.env`, run `make setup`, and the agent handles email and Slack as Haakam.

## How it works

Claude Code is the agent. Mega is the supervisor that drives it.

- **AgentMail and Slack** are brokered by [fabric](https://github.com/Haakam21/fabric). Fabric receives provider webhooks, verifies signatures, and forks one Spool thread per email/Slack conversation. Mega doesn't run a webhook server for them.
- **Spool** is the event bus. Mega tails a discovery cursor on each channel's parent thread; every new fork spawns a per-fork consumer.
- **Each per-fork consumer** invokes Claude Code with a stable session id (the fork's thread name), so the conversation maintains context across messages.
- **Replies** are published back to the same fork as `ns=message, type=end`. Fabric tails for those and dispatches via the provider's reply API.
- **Linear** is the one channel Mega still receives directly — `/linear/webhook` is a signed HMAC webhook that publishes to a passive audit thread.
- **memfs** syncs memory across all agent instances.

## Quick start

```bash
git clone <repo-url> mega && cd mega
cp .env.example .env    # Fill in MEMFS_* and GITHUB_TOKEN; set MEGA_AGENTMAIL_PARENT and/or MEGA_SLACK_PARENT
make setup              # Install deps, configure memfs
make start              # Start the harness
```

The fabric side (connectors + webhooks + Spool bindings) is set up separately — see `CLAUDE.md` → "How Email Works" and "How Slack Works" for the operator runbook.

## Commands

```bash
make setup    # First-time setup (deps, memfs, env validation)
make start    # Start the agent (tree-kills any existing instance first)
make stop     # Stop the agent (tree-kills the whole process group)
make status   # Show agent status
make test     # unit + e2e tests
```

`make stop` signals the harness's process group, so Claude invocations and their tool subprocesses are reaped together. Every invocation also has a wall-clock timeout (default 5 min, override with `MEGA_INVOKE_TIMEOUT_MS`) that tree-kills on expiry. See `CLAUDE.md` → "Process Safety" for the full story.

## Dependencies

- [Claude Code](https://claude.ai/code) — the agent
- [Bun](https://bun.sh) — TypeScript runtime
- [gh](https://cli.github.com) — GitHub CLI for PR review
- [jq](https://jqlang.github.io/jq/) — JSON parser used by `make` recipes
- [memfs](https://github.com/Haakam21/mem-fs) — shared memory across instances

`make setup` verifies each of these before running any configuration steps.

## Configuration

All secrets live in `.env` (gitignored). `MEMFS_*` and `GITHUB_TOKEN` are required. At least one channel must be configured:

```
# Required
MEMFS_SYNC_URL=
MEMFS_SYNC_TOKEN=
GITHUB_TOKEN=

# AgentMail-via-fabric (optional) — Spool parent thread fabric publishes
# email-thread forks into. Created on Spool with mega@<MEGA_DOMAIN> as
# owner; fabric-prod invited as writer.
MEGA_AGENTMAIL_PARENT=

# Slack-via-fabric (optional) — same shape.
MEGA_SLACK_PARENT=

# Linear (optional) — direct HMAC-signed webhook to /linear/webhook.
LINEAR_WEBHOOK_SECRET=

# Spool I/O substrate (defaults below)
# MEGA_SPOOL_URL=https://spool.computer
# MEGA_DOMAIN=india-desert.exe.xyz
# MEGA_HTTP_PORT=8000
```

## Architecture

Bun/TypeScript harness (`index.ts`) starts the consumer loops for whichever channels are configured. The runtime:

```
Spool thread.forked  →  per-fork consumer  →  core/invoke.ts  →  claude --print  →  publish message.end
                                                                                          ↓
                                                                                fabric outbound supervisor
                                                                                          ↓
                                                                                 provider reply API
```

- `core/spool-loop.ts` — `startAgentMailV2` / `startSlackV2`: discovery cursor + per-fork consumer. Shared shape.
- `core/invoke.ts` — claude-cli wrapping: dedup, tree-kill, timeout, session resume.
- `core/spool.ts` — TS Spool client.
- `linear/spool-relay.ts` — direct inbound (only channel Mega still serves a webhook for).
- `index.ts` — entrypoint. Channels gated on the env vars above.

See `CLAUDE.md` for the full project structure and per-channel details.

## Testing

```bash
make test-unit   # core utilities + linear webhook verify (~80 tests)
make test-e2e    # placeholder — provider e2e moved to fabric
```
