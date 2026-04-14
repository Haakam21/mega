# Changelog

All self-modifications by the agent are logged here.

## 2026-04-14 — Runaway-process fixes E, G, H: bounded dedup + watchdog + structured invocation logs
The remaining three follow-ups from the runaway-process plan. The fix set is now complete: A (timeout), B (tree-kill), C (channel concurrency cap), D (make stop tree-kill), E (bounded dedup), F (stderr capture), G (watchdog), H (richer logs).

**E — bounded `.seen_events`** (`core/invoke.ts`)
- The dedup cache used to grow unbounded and was loaded entirely into memory at startup. After enough events, both the file and the in-memory `Set` would balloon.
- Now capped at `MEGA_MAX_SEEN_EVENTS` (default 10 000). When the in-memory list exceeds the cap, the oldest half is evicted and the file is rewritten. Most adds are still cheap appendFile; the rotation O(cap) work happens once every ~cap/2 events, not on every event.
- Initial load truncates to the last `cap` lines from disk so a stale unbounded file from before this fix gets pruned on first startup.
- New tests (`core/invoke.test.ts`, 4 cases): unseen → false, repeats → true, empty event id → opt-out, rotation drops oldest half, repeated rotations stay bounded indefinitely.

**G — process-count watchdog** (`core/watchdog.ts`, new file)
- Every `MEGA_WATCHDOG_INTERVAL_MS` (default 30 s) the harness runs `pgrep -cf "^claude --print"` and warns into `harness.log` if the count exceeds `MEGA_WATCHDOG_THRESHOLD` (default 8). Pattern overridable via `MEGA_WATCHDOG_PATTERN` for test isolation.
- Belt-and-suspenders: if every other defense layer somehow lets a leak through, the watchdog surfaces it before the host dies. Won't tree-kill anything itself; just observability.
- The interval timer is `unref()`'d so it never blocks process exit. First tick runs immediately on startup so an already-leaked state surfaces fast.
- New tests (`core/watchdog.test.ts`, 9 cases): real `pgrep` smoke (zero-match, exists-pattern), `watchdogTick` warn semantics (under/at/above threshold, passthrough), `startWatchdog` env overrides + handle stop.
- Wired into `index.ts` after channel startup.

**H — structured invocation lifecycle logging** (`core/invoke.ts`)
- Every `[invoke]` log line now includes `session=` and `pid=` fields so operators can correlate harness.log entries to specific threads when diagnosing a hang. The previous logs only had `pid=`, which was useless for cross-referencing once an invocation died.
- Added structured fields throughout: `prompt_bytes=` on start, `output_bytes=` on exit, `duration=` on exit (was already there), `args=` on spawn (resume vs session-id), explicit `kill` / `timeout` / `grace expired` / `error` / `parse error` events, and a `resume failed → retrying with --session-id` line for the fallback path.
- Long session ids are truncated to 24 chars + `…` in log lines so they fit on one line and don't leak gratuitously into logs.

Test results: **49/49 unit pass** (was 36 after C), 5 test files. New: `core/watchdog.test.ts`. Updated: `core/invoke.test.ts`. Wired into `make test-unit`.

`CLAUDE.md` Process Safety section now lists all five layers + the watchdog. `core/watchdog.ts` added to the project structure listing.

The runaway-process fix set is **complete**.

## 2026-04-14 — Runaway-process fix C: AgentMail concurrency cap + interrupt
The fourth defense layer from the runaway-process plan (after timeout, tree-kill, and group-kill on stop). Closes the "email flood spawns N concurrent invocations" hole.

- `agentmail/channel.ts` rewritten to use `invokeWithHandle` instead of fire-and-forget `invoke`. Per-thread `activeInvocations` map mirrors Slack's pattern: a new email in an already-active thread kills the in-flight invocation and respawns with all accumulated messages merged into a single prompt. No new slot consumed.
- Global cap: `MEGA_AGENTMAIL_MAX_CONCURRENT` (default 4) limits distinct active threads. Excess events queue up to `MEGA_AGENTMAIL_MAX_QUEUE` (default 100); beyond that they're dropped with a warning. The queue drains automatically as slots free, with the same merge-or-new logic so a queued email whose thread became active mid-wait merges into the active invocation instead of taking a new slot.
- `buildPrompt(events[])` extracted as a pure function. Single-message inputs render in the legacy `New email received: ...` format; multi-message inputs render numbered `--- Email N ---` blocks with the latest message id called out as the reply target.
- New `agentmail/channel.test.ts`: 9 unit tests covering single + multi prompt rendering and the queueing state machine (slot allocation, interrupt-and-merge, cap, queue overflow). Test seam via `__resetForTests` + `__stateForTests` keeps the in-memory state inspectable without mocking the actual claude spawn — tests use `MEGA_CLAUDE_BIN=test/slow-claude.sh` so spawned invocations stay running while the test inspects state.
- `Makefile` wires the new test file into `test-unit`. Total: 36 unit tests, 0 fail (was 27).
- `CLAUDE.md` Process Safety section now lists four defense layers; "How Email Works" documents the per-thread interrupt and the concurrency env vars.

Now of the runaway-process follow-ups, three remain: **E** (rotate `.seen_events`), **G** (process count watchdog), **H** (richer invocation lifecycle logging).

## 2026-04-14 — memfs 0.12.4: latent FUSE flush() correctness bug + test isolation
A `/simplify` review pass on memfs 0.12.2 surfaced (and the follow-up tests caught) two real bugs upstream that shipped as `Haakam21/mem-fs` v0.12.3 + v0.12.4:

- **v0.12.3** ([`2f5a851`](https://github.com/Haakam21/mem-fs/commit/2f5a851)) — cleanup pass: extracted `fuse::lazy_unmount()` (was duplicated and drifting between `stop_mount` and `fuse::mount`'s pre-clean), `DEFAULT_FACETS` constant, fixed `init` swallowing `db::migrate` errors with `let _ = ...`, fixed macOS `is_fuse_mounted` false-matching `/mnt` against `/mnt-old`, replaced bash test `sleep 2` magic numbers with a poll loop. New shared `tests/lib/fuse_mount.sh` helper used by all three test scripts.

- **v0.12.4** ([`c9324d3`](https://github.com/Haakam21/mem-fs/commit/c9324d3)) — three "pre-existing" test_integration.sh failures turned out to be three real bugs:
  1. Test 14 case-drift in expected error string (one-line fix).
  2. The standalone `search` binary hardcoded `$HOME/.memfs` and ignored `MEMFS_DB`, so every invocation was reading from the developer's *real* memfs db regardless of test isolation. Rewrote as `find_db_path()` that resolves `MEMFS_DB` env → walk up from cwd → `$HOME/.memfs/db`, matching the memfs CLI.
  3. **Latent FUSE correctness bug**: FUSE `release()` is async — the kernel does NOT wait for the daemon's release-reply before returning from `close()`. So `echo > file && stop_fuse_mount` could kill the daemon mid-flush and lose the buffered content. Memory was tagged correctly (because `create()` had run) but content was empty. Implemented `flush()` (which the kernel DOES wait for on close) that persists the buffer synchronously; `release()` stays as cleanup with a defensive late-write check.

  The flush bug bites *anyone* using the pattern "write a file → kill the daemon → read the db", not just our tests. The new `tests/test_fuse_write.sh` is what surfaced it. Test results upstream went 34/37 → 37/37 + 7/7 + 3/3.

After upgrading: same Mega-side workflow — `./memories/topics/foo.md` writes are correctly indexed, tagged, and synced. `make setup-memfs` will pick up 0.12.4 on next run; this clone's `~/.memfs/memfs` is already on 0.12.4.

## 2026-04-14 — Tests + docs for the runaway-process fix set
- `core/invoke.ts`: env vars (`MEGA_CLAUDE_BIN`, `MEGA_INVOKE_TIMEOUT_MS`) are now read lazily inside `runClaude` so tests can override them between calls.
- `core/invoke.test.ts`: 4 new integration tests that drive `invokeWithHandle` end-to-end with mock binaries:
    1. Mock claude: returns a JSON result through the full invoke path.
    2. Timeout: a hung claude gets tree-killed after `MEGA_INVOKE_TIMEOUT_MS`.
    3. Kill via handle: `handle.kill()` terminates an in-flight invocation quickly.
    4. Tree-kill reaches children: `handle.kill()` reaps grandchild subprocesses spawned by the mock.
- Existing `treeKill` unit test rewritten to pass `TREE_CHILD_PID_FILE` via env (matches the new mock signature).
- `test/tree-claude.sh` rewritten: reads `TREE_CHILD_PID_FILE` from env instead of `$1`, so the same script works for standalone tree-kill tests and for invoke-driven tests where claude-style args are passed positionally.
- `CLAUDE.md`: new "Process Safety" section documenting the timeout + tree-kill + testing hooks. Updated project-structure listing and Testing section.
- `README.md`: `make stop` description clarified (tree-kill), mention of `MEGA_INVOKE_TIMEOUT_MS`, dependencies list corrected (Bun not Node, added `gh`, fixed memfs URL).
- Test totals: **27 pass / 0 fail** (was 23 after the previous pass, was 22 before the runaway-process work started).

## 2026-04-14 — Invocation timeout + tree-kill (runaway-process fix set A/B/D/F)

Fixes for the "Mega Claude sessions pile up and crash the host" class of bug. Diagnosis: no timeout on `runClaude`, `proc.kill()` only signalled the top-level `claude` process (orphaning its Node/MCP/tool subprocesses), `make stop` only killed the Bun harness (leaving Claude children re-parented to init), and `stderr: "ignore"` hid every hang from the logs.

- **`core/invoke.ts`** rewritten to use Node's `child_process.spawn` with `detached: true` so every Claude invocation lives in its own process group. Added a wall-clock timeout (default 5 min, override via `MEGA_INVOKE_TIMEOUT_MS`) that tree-kills with SIGTERM then SIGKILL after a 2s grace. Exported a `treeKill` helper. Switched stderr from `"ignore"` to `"inherit"` so Claude errors land in `harness.log`. Lifecycle logging on start/kill/timeout/exit with PID + duration.
- **`Makefile`**:
    - `start` now runs the harness under `setsid` so it's a session leader; `harness.pid` holds the PGID.
    - `stop` tree-kills via `kill -TERM -- -$pgid`, polls for group death, then `SIGKILL`s anything stubborn. Belt-and-suspenders `pkill -KILL -f "^claude --print"` cleans up orphans from earlier runs that predate this Makefile.
    - Added `SHELL := /bin/bash` — Debian's `/bin/sh` is dash, whose builtin `kill` rejects `--` and negative PIDs, so the tree-kill logic silently no-oped under the default shell. Caught while verifying `make stop` end-to-end.
- **Tests**: added `test/tree-claude.sh` (mock that spawns a long-lived child) and a `treeKill` unit test that verifies the process-group signal actually reaches child processes. Full suite: 23 pass / 0 fail.
- Follow-ups not in this pass: C (AgentMail concurrency/interrupt), E (bounded `.seen_events`), G (process watchdog), H (more invocation logging).

## 2026-04-14 — Fix silent FUSE mount failure (upstream memfs v0.12.2)
Writing directly to `./memories/topics/foo.md` (through the FUSE symlink) was silently creating **unindexed** files on the backing directory — `ls memories/` saw them, but `memfs find`, `memfs search`, and `memfs sync` did not. Root cause: fuser silently enables `allow_other` when AutoUnmount is set, which fusermount3 rejects unless `/etc/fuse.conf` has `user_allow_other`. The systemd unit then crash-looped silently, and `memfs init`'s old `read_dir().is_ok()` health check saw the backing directory and reported "Mounted" anyway. Writes to `memfs/topics/*.md` ended up on the backing fs, which `init` had pre-seeded as real directories (compounding the shadow).

Fixed upstream in [`a728ae1`](https://github.com/Haakam21/mem-fs/commit/a728ae1) (released as `v0.12.2`):
- `memfs init` now checks `/etc/fuse.conf` for `user_allow_other` on Linux and bails with the exact `echo user_allow_other | sudo tee -a /etc/fuse.conf` fix command if missing.
- Mount health check replaced with `is_fuse_mounted()` which reads `/proc/self/mountinfo` (Linux) or `mount(8)` (macOS) looking for a fuse-type entry at the target path.
- Facet categories are now seeded in the db (`facets` table) instead of as real backing directories, so they never shadow the FUSE view. Legacy facet dirs from older inits get `remove_dir_all`'d on the next init run.

After upgrading to memfs 0.12.2, Claude can write memories with a normal file API (`./memories/topics/foo.md`) and they're properly indexed, tagged (`topics:foo`), and synced. No more "use `memfs write` CLI" workaround.

Mega's `setup-memfs` target needs no change — existing clones will get 0.12.2 on their next `make setup-memfs`, and the upstream error message surfaces cleanly through the pipe.

## 2026-04-14 — memfs credential rotation works via `make setup-memfs`
- Contributed upstream fix to `Haakam21/mem-fs` ([`ccf13fd`](https://github.com/Haakam21/mem-fs/commit/ccf13fd), released as `v0.12.1`): `memfs init` now always prompts for Turso URL/token, and blank input keeps the existing value. Previously init skipped the prompt entirely when `~/.memfs/settings.json` already existed, so piped automation couldn't rotate credentials.
- No Mega code change needed — `setup-memfs` already pipes `MEMFS_SYNC_URL` / `MEMFS_SYNC_TOKEN` into init's stdin every run. With memfs ≥ 0.12.1, that makes rotation a simple "edit `.env`, run `make setup-memfs`" workflow.
- Added `memories/topics/memfs_credential_rotation.md` so any Mega instance that needs to rotate creds finds the procedure.

## 2026-04-14 — Tests, docs, memory follow-up to optional AgentMail
- `agentmail/e2e.test.ts` now uses `describe.skipIf(!apiKey || !inboxId)` so `make test-e2e` auto-skips the AgentMail tests when the channel is disabled instead of throwing in `beforeAll`. `make test` passes cleanly on Slack-only clones (22 unit pass, 4 e2e skipped).
- `CLAUDE.md` Architecture section now frames channels as independently optional and lists the env vars for each.
- `README.md` Architecture/Testing sections rewritten — removed stale references to `agentmail/ws.js`, `listener.sh`, and `agentmail/test.sh` that predated the Bun/TypeScript rewrite.
- Saved project memory at `./memories/topics/agentmail_blocked_on_exedev.md` so every Mega instance (not just Claude Code auto-memory) knows the AgentMail block is upstream CloudFront WAF, not a bug to chase.

## 2026-04-14 — Make AgentMail channel optional (parity with Slack)
- `setup-env` no longer treats `AGENTMAIL_API_KEY`/`AGENTMAIL_INBOX_ID` as required. Only `MEMFS_*` and `GITHUB_TOKEN` are strictly required now.
- New rule: at least one channel (AgentMail or Slack) must be configured — `setup-env` errors out if both are blank.
- `setup` and `status` summaries now show enabled/disabled state per channel instead of always echoing the AgentMail inbox.
- `.env.example` and `README.md` updated to group required vs. optional vars and mark each channel as independently optional.
- `index.ts` already started channels conditionally, so no runtime code change was needed.
- Motivation: AgentMail's WebSocket endpoint is blocked by a CloudFront WAF rule against AWS datacenter egress IPs (exe.dev VMs exit from us-west-2). Disabling AgentMail on this clone silences the reconnect spam; Slack handles messaging in the meantime.

## 2026-04-14 — Portable setup: auto-derive sessions path, automate memfs init
- `setup-sessions` now derives the Claude projects dir from `$PWD` (slashes → dashes), so it works on any machine/user instead of hardcoding `-Users-agent-mail1-mega`. If the symlink already points somewhere else, it gets re-created.
- `setup-memfs` now runs `memfs init` automatically, piping `MEMFS_SYNC_URL`/`MEMFS_SYNC_TOKEN` from `.env` into its prompts. Fresh clones no longer need a manual init step.
- Reordered `make setup` so `setup-env` runs before `setup-memfs` (init needs the sync creds loaded).
- Caught during a fresh-clone walkthrough with Haakam; CLAUDE.md promises portability across macOS/Linux and the hardcoded path violated that.

## 2026-04-14 — Fix memfs install URL in Makefile
- `setup-memfs` was pointing at `https://memfs.io/install.sh`, which doesn't resolve
- Repointed at the canonical source: `https://raw.githubusercontent.com/Haakam21/mem-fs/main/install.sh`
- Caught while running `make setup` on a fresh clone — Haakam confirmed the correct URL

## 2026-04-13 — Session transcript access
- Added `./sessions/` symlink → `~/.claude/projects/-Users-agent-mail1-mega/` so Claude can read/grep past session transcripts
- Added `setup-sessions` step to Makefile (runs during `make setup`)
- Updated CLAUDE.md to document session transcripts
- Gitignored `sessions` (runtime symlink, not portable)

## 2026-04-13 (session 5) — Slack thread context recovery
- Fixed: replies to proactive messages (bot-initiated threads) started fresh sessions with no context
- Added `fetchThreadHistory()` — calls `conversations.replies` to get all prior messages in the thread
- Added `formatThreadHistory()` — formats prior messages as `[mega]` or `[userId]` lines
- Updated `buildPrompt()` to accept and prepend thread history
- `handleMessage()` now fetches thread history before every invocation
- One Slack API call per message, no new deps
- Also learned: should always check thread history via Slack API when entering a thread (noted for future use)

## 2026-04-13 (session 4) — Proactive Slack DMs & email attachments
- Added `im:write` scope to `slack/manifest.json` so Mega can initiate DMs (not just respond)
- Verified proactive messaging works: `conversations.open` → `chat.postMessage`
- Discovered AgentMail send endpoint uses `text` field (not `body`) and supports `attachments` array with base64-encoded content
- Updated CLAUDE.md with Slack proactive DM docs, Haakam's Slack IDs, and email attachment format

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
