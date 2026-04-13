# Changelog

All self-modifications by the agent are logged here.

## 2026-04-13 (session 3) — Fix channel tool access & memories
- Fixed `core/invoke.ts`: added `cwd: ROOT` so Claude runs in the project directory (reads CLAUDE.md, can access memories)
- Fixed `core/invoke.ts`: added `--dangerously-skip-permissions` so Claude has full tool access in `--print` mode (same capabilities as interactive session)
- Fixed channel system prompts: replaced overly restrictive "Output ONLY the message text" with lighter guidance that doesn't discourage tool use
- Root cause: `--print` mode without permission flags blocked all tool use, and the old system prompt told Claude to skip tools entirely
- Debugged FUSE/symlink red herring: Claude's Read/Glob tools work fine on the memfs FUSE mount — the issue was purely permissions + system prompt
- Updated CLAUDE.md to document channel invocation flags

## 2026-04-13 (session 2)
- Changed inbox from `sillyagreement801@agentmail.to` to `mega1@agentmail.to`
- `mega@agentmail.to` was taken, settled on `mega1`

## 2026-04-13
- Rewrote agent harness from bash/node to Bun + TypeScript
- Factored shared logic into `core/invoke.ts` (dedup, Claude invocation, session continuity)
- Added `core/websocket.ts` — shared reconnecting WebSocket client with close handle
- Rewrote AgentMail listener as `agentmail/channel.ts` (replaces `listener.sh` + `ws.js`)
- Added Slack Socket Mode integration (`slack/channel.ts`)
- Slack Agent mode: `assistant_view` feature, suggested prompts, appears in Agents tab
- Slack message interruption: new messages kill in-progress Claude invocations and restart with combined context
- Slack thinking indicator: 🤔 reaction on latest message (doesn't block input)
- `invokeWithHandle()` returns killable handle for Slack interruption support
- Single entrypoint: `bun run index.ts` starts all configured channels
- Updated Makefile: `bun` replaces `node`, added `make test` / `test-unit` / `test-e2e`
- Added `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` to `.env.example`
- Established clone identity: name is **Mega**, not Haakam
- Added test suite: 19 unit tests (bun test) + 2 E2E tests (AgentMail)
- Deleted `agentmail/listener.sh`, `agentmail/ws.js`, `agentmail/test.sh`

## 2026-04-11
- Added GitHub code review capability
- Added `GITHUB_TOKEN` to `.env.example` and `.env`
- Added `gh` CLI as a dependency in Makefile
- Added `GITHUB_TOKEN` validation to `setup-env` in Makefile
- Added `setup-github` step to verify GitHub auth works during `make setup`
- Updated `CLAUDE.md` with code review architecture and workflow docs
