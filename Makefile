COMPOSE := docker compose -f docker/compose.yaml

.PHONY: help tools anvil demo lab-up lab-pause lab-status lab-logs lab-nuke clean

help: ## Show available targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-12s %s\n", $$1, $$2}'

tools: ## Install pinned Anvil into ./.tools/bin (project-local)
	./scripts/install-anvil.sh

anvil: tools ## Run a local chain on 127.0.0.1:8545 (foreground)
	./.tools/bin/anvil --host 127.0.0.1 --chain-id 31337

demo: tools ## Run the example agent against a fresh local chain; traces go to Jaeger (make lab-up)
	@./.tools/bin/anvil --host 127.0.0.1 --port 8545 --silent & pid=$$!; \
	trap 'kill $$pid 2>/dev/null' EXIT; \
	until curl -s -o /dev/null -X POST -H 'content-type: application/json' \
	  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:8545; do sleep 0.2; done; \
	pnpm demo

lab-up: ## Start Jaeger (UI: http://localhost:16686, OTLP: localhost:4317/4318)
	$(COMPOSE) up -d

lab-pause: ## Stop lab containers, keep images and volumes
	$(COMPOSE) stop

lab-status: ## Show lab containers
	$(COMPOSE) ps

lab-logs: ## Follow lab logs
	$(COMPOSE) logs -f

lab-nuke: ## Remove lab containers, volumes, images, local tools and build output
	$(COMPOSE) down -v --rmi all --remove-orphans
	$(MAKE) clean

clean: ## Remove node_modules, build output and .tools
	rm -rf .tools node_modules packages/*/node_modules packages/*/dist examples/*/node_modules coverage
