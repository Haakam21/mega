# Use bash explicitly. Several recipes (notably the tree-kill logic in `stop`)
# pass `kill -TERM -- -$pgid` which relies on the shell's builtin kill
# handling `--` and negative PIDs. dash (Debian/Ubuntu's /bin/sh) errors on
# that syntax, so recipes silently no-op under the default sh.
SHELL := /bin/bash

.PHONY: setup setup-deps setup-sessions setup-memfs setup-env setup-github start stop status logs test test-unit test-e2e

# Agent image setup — run once on a new machine
setup: setup-deps setup-env setup-sessions setup-memfs setup-github
	@echo ""
	@echo "Agent setup complete."
	@. ./.env && \
	[ -n "$$AGENTMAIL_INBOX_ID" ] && echo "AgentMail inbox: $$AGENTMAIL_INBOX_ID" || echo "AgentMail: disabled"; \
	[ -n "$$SLACK_BOT_TOKEN" ] && echo "Slack: enabled" || echo "Slack: disabled"
	@echo "Run 'make start' to start the agent."

# Step 1: Install dependencies
setup-deps:
	@echo "=== Checking dependencies ==="
	@command -v claude >/dev/null || (echo "Error: claude CLI not found. Install from https://claude.ai/code" && exit 1)
	@command -v jq >/dev/null || (echo "Error: jq not found. Install with: brew install jq" && exit 1)
	@command -v bun >/dev/null || (echo "Error: bun not found. Install with: curl -fsSL https://bun.sh/install | bash" && exit 1)
	@command -v gh >/dev/null || (echo "Error: gh not found. Install with: brew install gh" && exit 1)
	@echo "All dependencies OK."

# Step 2: Session transcripts — symlink Claude's session storage into project
# Claude Code encodes the project dir as $PWD with slashes → dashes
# (e.g. /home/exedev/mega → -home-exedev-mega), so derive it rather than hardcoding.
setup-sessions:
	@echo "=== Setting up session transcripts ==="
	@proj=$$(echo "$$PWD" | sed 's|/|-|g'); \
	target="$$HOME/.claude/projects/$$proj"; \
	if [ -L sessions ] && [ "$$(readlink sessions)" = "$$target" ]; then \
		echo "sessions symlink already correct."; \
	else \
		rm -f sessions && ln -sf "$$target" sessions; \
		echo "Linked sessions → $$target"; \
	fi

# Step 4: Memory system — install binary and initialize sync/mount
# Runs after setup-env so MEMFS_SYNC_URL/TOKEN are available for init's prompts.
setup-memfs:
	@echo "=== Setting up memory system (memfs) ==="
	@if [ -x "$$HOME/.memfs/memfs" ]; then \
		echo "memfs already installed."; \
	else \
		echo "Installing memfs..."; \
		curl -fsSL https://raw.githubusercontent.com/Haakam21/mem-fs/main/install.sh | bash; \
	fi
	@. ./.env && printf '%s\n%s\n' "$$MEMFS_SYNC_URL" "$$MEMFS_SYNC_TOKEN" | "$$HOME/.memfs/memfs" init >/dev/null
	@echo "memfs initialized (sync configured, FUSE mounted, ./memories linked)."

# Step 3: Validate environment — must run before setup-memfs, which reads sync creds from .env
setup-env:
	@echo "=== Checking environment ==="
	@if [ ! -f .env ]; then \
		cp .env.example .env; \
		echo "Created .env from template. Fill in all values."; \
		exit 1; \
	fi
	@. ./.env && \
	missing="" && \
	[ -z "$$MEMFS_SYNC_URL" ] && missing="$$missing MEMFS_SYNC_URL" ; \
	[ -z "$$MEMFS_SYNC_TOKEN" ] && missing="$$missing MEMFS_SYNC_TOKEN" ; \
	[ -z "$$GITHUB_TOKEN" ] && missing="$$missing GITHUB_TOKEN" ; \
	if [ -n "$$missing" ]; then \
		echo "Error: missing required values in .env:$$missing"; \
		exit 1; \
	fi; \
	agentmail_set=""; slack_set=""; \
	[ -n "$$AGENTMAIL_API_KEY" ] && [ -n "$$AGENTMAIL_INBOX_ID" ] && agentmail_set=1; \
	[ -n "$$SLACK_BOT_TOKEN" ] && [ -n "$$SLACK_APP_TOKEN" ] && slack_set=1; \
	if [ -z "$$agentmail_set" ] && [ -z "$$slack_set" ]; then \
		echo "Error: at least one channel must be configured in .env (AgentMail or Slack)."; \
		exit 1; \
	fi; \
	[ -n "$$agentmail_set" ] && am="enabled" || am="disabled"; \
	[ -n "$$slack_set" ] && sl="enabled" || sl="disabled"; \
	echo "Required env OK. Channels — agentmail: $$am, slack: $$sl"

# Step 4: Verify GitHub CLI authentication
setup-github:
	@echo "=== Verifying GitHub authentication ==="
	@. ./.env && GITHUB_TOKEN="$$GITHUB_TOKEN" gh auth status 2>&1 | head -4
	@echo "GitHub authentication OK."

# Start the agent — kills any existing instance first.
# setsid puts the harness in its own session/process group so `make stop`
# can tree-kill every claude subprocess by signalling the group.
#
# Append-mode redirect (>>) is load-bearing: the harness rotates harness.log
# from inside via core/log-rotator.ts when it exceeds MEGA_LOG_MAX_BYTES, and
# in-place truncate only frees disk space when fd 1 has O_APPEND. With plain
# `>` the kernel keeps the file descriptor's offset across truncates and
# subsequent writes create a sparse file with the offset as a hole.
start: stop
	@echo "Starting agent harness..."
	@setsid bash -c 'echo $$$$ > harness.pid; exec bun run index.ts' \
		>> harness.log 2>&1 < /dev/null &
	@sleep 0.2
	@echo "Agent harness started (PGID $$(cat harness.pid))"

# Stop the agent — tree-kills the whole process group.
# Signalling a negative PID on Linux delivers the signal to every process
# in the group, so orphaned claude children get cleaned up too.
stop:
	@if [ -f harness.pid ]; then \
		pgid=$$(cat harness.pid); \
		if kill -0 -- -$$pgid 2>/dev/null; then \
			kill -TERM -- -$$pgid 2>/dev/null || true; \
			for i in 1 2 3 4 5 6 7 8; do \
				kill -0 -- -$$pgid 2>/dev/null || break; \
				sleep 0.25; \
			done; \
			kill -KILL -- -$$pgid 2>/dev/null || true; \
		fi; \
	fi
	@# Belt-and-suspenders: reap any orphaned claude processes left from
	@# earlier runs that predate the tree-kill Makefile.
	@pkill -KILL -f "^claude --print" 2>/dev/null || true
	@rm -f harness.pid
	@echo "Agent harness stopped."

# Tail the harness log. Follows by name (-F) so it survives the
# log-rotator's in-place truncation without skipping a beat.
logs:
	@tail -F harness.log

# Show agent status
status:
	@echo "=== Agent Status ==="
	@if [ -f .env ]; then \
		. ./.env; \
		[ -n "$$AGENTMAIL_INBOX_ID" ] && echo "AgentMail inbox: $$AGENTMAIL_INBOX_ID" || echo "AgentMail: disabled"; \
		[ -n "$$SLACK_BOT_TOKEN" ] && echo "Slack: enabled" || echo "Slack: disabled"; \
	else \
		echo "No .env file."; \
	fi
	@if [ -f harness.pid ] && kill -0 $$(cat harness.pid) 2>/dev/null; then \
		echo "Agent harness: running (PID $$(cat harness.pid))"; \
	else \
		echo "Agent harness: stopped"; \
	fi

# Run all tests (unit + E2E — harness must be running for E2E)
test: test-unit test-e2e

# Unit tests only
test-unit:
	@bun test core/env.test.ts core/interval.test.ts core/invoke.test.ts core/log-rotator.test.ts core/watchdog.test.ts core/websocket.test.ts slack/channel.test.ts agentmail/channel.test.ts

# E2E tests (requires harness running + .env configured)
test-e2e:
	@bun test agentmail/e2e.test.ts --timeout 130000
