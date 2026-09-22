# Thin wrapper over docker compose. See README, "Running on a Raspberry Pi 5 with Docker".

.PHONY: up down logs build seed update

# Start the app. Builds the images on first run, applies migrations, then serves
# on http://localhost:10000. Run `make seed` once after this to create the user.
up:
	docker compose up -d
	@echo ""
	@echo "  Open http://localhost:10000"
	@echo ""

down:
	docker compose down

logs:
	docker compose logs -f

# Force a rebuild after changing source.
build:
	docker compose build

# Create the single user account, using SEED_USER_EMAIL / SEED_USER_PASSWORD
# from .env. Idempotent: running it again changes nothing.
seed:
	docker compose run --rm migrate node dist/db/seed.js

# Deploy the latest `main` on the Pi: pull, rebuild, restart.
#
# Run this ON THE PI, from the checkout that `docker compose` was started in.
#
# `--ff-only` so a diverged checkout FAILS here rather than silently producing a
# merge commit on the box — if it refuses, someone committed on the Pi and that
# needs looking at, not automating away.
#
# Build and up are separate steps on purpose: a failed build leaves the OLD
# containers running and serving, so a broken commit costs you nothing. `up -d`
# is what swaps them, and only after the new image exists.
#
# `up -d` also does the right thing without extra flags, because compose honours
# the dependency conditions in docker-compose.yml: `migrate` runs to completion
# first (idempotent — drizzle skips already-applied migrations), then `api`, and
# `web` waits for `api` to pass its healthcheck. So this command returning 0
# means the new API answered /api/v1/health, not merely that a container started.
#
# It deliberately does NOT seed: creating the user is an explicit act (`make
# seed`), not a side effect of a deploy.
#
# The database lives in the `finance-data` named volume and is untouched by any
# of this. There is still no off-Pi backup — see `think/`.
update:
	git pull --ff-only
	docker compose build
	docker compose up -d
	@echo ""
	@echo "  Updated to $$(git rev-parse --short HEAD). Old images are now dangling;"
	@echo "  reclaim the space with 'docker image prune -f' when disk gets tight."
	@echo ""
