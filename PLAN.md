# Mega — Implementation Plan

## Goal
Portable agent image: clone, `make setup`, running digital clone of Haakam.

---

## Phase 1: Foundation — DONE
- [x] Memory system (memfs) configured and syncing
- [x] AgentMail inbox created
- [x] `.env` for secrets, `.env.example` as template
- [x] Makefile: `make setup`, `make start`, `make stop`, `make status`

## Phase 2: Email (AgentMail) — DONE
- [x] Node.js WebSocket client (`ws.js`) connects and subscribes
- [x] Bash listener (`listener.sh`) processes events and invokes Claude Code
- [x] Replies sent via AgentMail API (curl + jq for proper JSON escaping)
- [x] Session continuity: same thread = same Claude session (thread ID as session ID)
- [x] Event deduplication via `.seen_events` file
- [x] Auto-reconnect on WebSocket disconnect
- [x] End-to-end test script (`test.sh`)

## Phase 3: Self-Improvement — TODO
- [ ] Track corrections when Haakam overrides a reply
- [ ] Learn communication style from Haakam's sent messages
- [ ] Update CLAUDE.md and roles with refined style notes
- [ ] Log all self-modifications to CHANGELOG.md

## Phase 4: Proactiveness — TODO
- [ ] Periodic inbox scan for unanswered emails
- [ ] Surface relevant context proactively
- [ ] Flag stale threads

## Phase 5: Additional Channels — TODO
- [ ] Slack integration
