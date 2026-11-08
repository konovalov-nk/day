DAY_HOST ?= 127.0.0.1
DAY_PORT ?= 3037
DAY = npm run --silent day --

.PHONY: help setup prepare demo start stop status open today ci test e2e e2e-install lint typecheck bench deploy tutorial report clean

help:
	@echo "Day — local-first daily plan and activity example"
	@echo ""
	@echo "  make setup      Install dependencies, create .env, migrate stores, import personal goals"
	@echo "  make demo       Create the labelled demo scenario"
	@echo "  make start      Start the dashboard in the background"
	@echo "  make status     Show server, watcher, and store status"
	@echo "  make stop       Stop the dashboard without deleting data"
	@echo "  make open       Print the dashboard URL"
	@echo "  make today      Print the current day from the CLI"
	@echo "  make tutorial   Show the guided task cycle"
	@echo "  make report     Open the weekly report URL"
	@echo "  make ci         Run lint, types, unit/integration tests, and Playwright"
	@echo "  make test       Run unit and integration tests"
	@echo "  make e2e        Run Playwright tests"
	@echo "  make e2e-install  Download the Chromium browser once"
	@echo "  make bench      Run the one-year performance check"
	@echo "  make deploy     Check Caddy and HTTPS"
	@echo "  make clean      Remove build and test output"

setup:
	npm install --no-audit --no-fund
	$(DAY) setup

prepare:
	$(DAY) prepare

demo:
	$(DAY) demo seed

start:
	$(DAY) start

stop:
	$(DAY) stop

status:
	$(DAY) status

open:
	$(DAY) open

today:
	$(DAY) today

tutorial:
	$(DAY) start
	$(DAY) tutorial status
	$(DAY) open

report:
	$(DAY) report --period week

ci:
	bash scripts/check-private.sh
	npm run ci

test:
	npm test

e2e-install:
	npx playwright install chromium

e2e:
	npx playwright test

lint:
	npm run lint

typecheck:
	npm run typecheck

bench:
	npx tsx scripts/bench.ts

deploy:
	$(DAY) deploy

clean:
	rm -rf dist test-results playwright-report blob-report
