COMPOSE := docker compose -f docker/compose.yaml

.PHONY: help tools anvil demo demo-base-sepolia lab-up lab-metrics lab-pause lab-status lab-logs lab-nuke clean

help: ## Show available targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-18s %s\n", $$1, $$2}'

tools: ## Install pinned Anvil and the ERC-4337 bundler Alto into ./.tools (project-local, for integration tests)
	./scripts/install-anvil.sh
	./scripts/install-bundler.sh

anvil: ## Run a local chain on 127.0.0.1:8545 (foreground)
	@./scripts/install-anvil.sh
	./.tools/bin/anvil --host 127.0.0.1 --chain-id 31337

demo: ## Run the example agent against a fresh local chain; traces go to Jaeger (make lab-up), metrics to Prometheus (make lab-metrics)
	@./scripts/install-anvil.sh
	@if curl -sf http://127.0.0.1:9090/-/ready >/dev/null 2>&1; then \
		export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://127.0.0.1:9090/api/v1/otlp/v1/metrics OTEL_METRIC_EXPORT_INTERVAL=1000; \
	fi; ./scripts/demo.sh

demo-base-sepolia: ## Run the example agent on Base Sepolia (needs BASE_SEPOLIA_PRIVATE_KEY, see the example README)
	@pnpm demo:base-sepolia

lab-up: ## Start Jaeger (UI: http://localhost:16686, OTLP: localhost:4317/4318)
	$(COMPOSE) up -d

lab-metrics: ## Start Jaeger, Prometheus and Grafana with the hashspan dashboard (Grafana: http://localhost:3000)
	$(COMPOSE) --profile metrics up -d

lab-pause: ## Stop lab containers, keep images and volumes
	$(COMPOSE) --profile metrics stop

lab-status: ## Show lab containers
	$(COMPOSE) --profile metrics ps

lab-logs: ## Follow lab logs
	$(COMPOSE) --profile metrics logs -f

lab-nuke: ## Remove lab containers, volumes, images, local tools and build output
	$(COMPOSE) --profile metrics down -v --rmi all --remove-orphans
	$(MAKE) clean

clean: ## Remove node_modules, build output and .tools
	rm -rf .tools node_modules packages/*/node_modules packages/*/dist examples/*/node_modules coverage
