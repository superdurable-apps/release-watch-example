SHELL := /usr/bin/env bash
# RUN selects the tests of make test-app by name, as a regular expression.
RUN ?=
TEST_FLAGS := --test $(if $(RUN),--test-name-pattern='$(RUN)')
TESTS := 'apptest/*.test.ts'

.PHONY: bootstrap restored check-fdg-v2 check-static test-app
# bootstrap restores node_modules; a second run waits for the first, and every
# other target waits for a run in progress.
bootstrap:
	./scripts/bootstrap.sh
restored:
	@mkdir -p .local && if command -v flock >/dev/null; then flock -s .local/bootstrap.lock true; fi
check-fdg-v2: restored
	python3 ./scripts/render-flow-definitions.py
check-static: check-fdg-v2
	npx --no-install tsc -p tsconfig.json
	npm run build
test-app: restored
	node $(TEST_FLAGS) $(TESTS)
