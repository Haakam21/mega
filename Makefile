.PHONY: setup setup-deps setup-sessions setup-memfs setup-env setup-github start stop status test test-unit test-e2e

# Agent image setup — run once on a new machine
setup: setup-deps setup-sessions setup-memfs setup-env setup-github
	@echo ""
	@echo "Agent setup complete."
	@. ./.env && echo "Inbox: $$AGENTMAIL_INBOX_ID"
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
setup-sessions:
	@echo "=== Setting up session transcripts ==="
	@if [ -L sessions ]; then \
		echo "sessions symlink already exists."; \
	else \
		echo "Linking sessions to Claude session storage..."; \
		ln -sf "$$HOME/.claude/projects/-Users-agent-mail1-mega" sessions; \
	fi

# Step 3: Memory system
setup-memfs:
	@echo "=== Setting up memory system (memfs) ==="
	@if [ -x "$$HOME/.memfs/memfs" ]; then \
		echo "memfs already installed."; \
	else \
		echo "Installing memfs..."; \
		curl -fsSL https://memfs.io/install.sh | sh; \
	fi
	@if [ ! -L memories ]; then \
		echo "Linking memories to memfs mount..."; \
		ln -sf "$$HOME/.memfs/mount" memories; \
	else \
		echo "memories symlink already exists."; \
	fi
	@echo "Run 'memfs init' if this is a fresh machine and you haven't configured sync yet."

# Step 3: Validate environment
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
	[ -z "$$AGENTMAIL_API_KEY" ] && missing="$$missing AGENTMAIL_API_KEY" ; \
	[ -z "$$AGENTMAIL_INBOX_ID" ] && missing="$$missing AGENTMAIL_INBOX_ID" ; \
	[ -z "$$GITHUB_TOKEN" ] && missing="$$missing GITHUB_TOKEN" ; \
	if [ -n "$$missing" ]; then \
		echo "Error: missing values in .env:$$missing"; \
		exit 1; \
	fi && \
	echo "All environment variables set."

# Step 4: Verify GitHub CLI authentication
setup-github:
	@echo "=== Verifying GitHub authentication ==="
	@. ./.env && GITHUB_TOKEN="$$GITHUB_TOKEN" gh auth status 2>&1 | head -4
	@echo "GitHub authentication OK."

# Start the agent — kills any existing instance first
start: stop
	@echo "Starting agent harness..."
	@nohup bun run index.ts > harness.log 2>&1 & \
	echo $$! > harness.pid; \
	echo "Agent harness started (PID $$!)"

# Stop the agent — kills current and any legacy processes
stop:
	@if [ -f harness.pid ] && kill -0 $$(cat harness.pid) 2>/dev/null; then \
		kill $$(cat harness.pid) 2>/dev/null || true; \
	fi
	@pkill -f "bun.*index\.ts" 2>/dev/null || true
	@pkill -f "agentmail/listener\.sh" 2>/dev/null || true
	@pkill -f "agentmail/ws\.js" 2>/dev/null || true
	@rm -f harness.pid agentmail/listener.pid
	@echo "Agent harness stopped."

# Show agent status
status:
	@echo "=== Agent Status ==="
	@. ./.env 2>/dev/null && echo "Inbox: $$AGENTMAIL_INBOX_ID" || echo "Inbox: not configured"
	@if [ -f harness.pid ] && kill -0 $$(cat harness.pid) 2>/dev/null; then \
		echo "Agent harness: running (PID $$(cat harness.pid))"; \
	else \
		echo "Agent harness: stopped"; \
	fi

# Run all tests (unit + E2E — harness must be running for E2E)
test: test-unit test-e2e

# Unit tests only
test-unit:
	@bun test core/invoke.test.ts core/websocket.test.ts slack/channel.test.ts

# E2E tests (requires harness running + .env configured)
test-e2e:
	@bun test agentmail/e2e.test.ts --timeout 130000
