.PHONY: setup start stop status

# Agent image setup — run once on a new machine
setup: setup-deps setup-memfs setup-env
	@echo ""
	@echo "Agent setup complete."
	@. ./.env && echo "Inbox: $$AGENTMAIL_INBOX_ID"
	@echo "Run 'make start' to start the agent."

# Step 1: Install dependencies
setup-deps:
	@echo "=== Checking dependencies ==="
	@command -v claude >/dev/null || (echo "Error: claude CLI not found. Install from https://claude.ai/code" && exit 1)
	@command -v jq >/dev/null || (echo "Error: jq not found. Install with: brew install jq" && exit 1)
	@command -v node >/dev/null || (echo "Error: node not found. Install from https://nodejs.org" && exit 1)
	@echo "All dependencies OK."

# Step 2: Memory system
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
	if [ -n "$$missing" ]; then \
		echo "Error: missing values in .env:$$missing"; \
		exit 1; \
	fi && \
	echo "All environment variables set."

# Start the agent — kills any existing listeners first
start: stop
	@echo "Starting AgentMail listener..."
	@nohup ./agentmail/listener.sh > agentmail/listener.log 2>&1 & \
	echo $$! > agentmail/listener.pid; \
	echo "AgentMail listener started (PID $$!)"

# Stop the agent — kills ALL related processes
stop:
	@pkill -f "agentmail/listener\.sh" 2>/dev/null || true
	@pkill -f "agentmail/ws\.js" 2>/dev/null || true
	@rm -f agentmail/listener.pid
	@echo "AgentMail listener stopped."

# Show agent status
status:
	@echo "=== Agent Status ==="
	@. ./.env 2>/dev/null && echo "Inbox: $$AGENTMAIL_INBOX_ID" || echo "Inbox: not configured"
	@if pgrep -f "agentmail/listener\.sh" >/dev/null 2>&1; then \
		echo "AgentMail listener: running (PID $$(pgrep -f 'agentmail/listener\.sh'))"; \
	else \
		echo "AgentMail listener: stopped"; \
	fi
