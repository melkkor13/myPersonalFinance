# Thin wrapper over docker compose. See README, "Running on a Raspberry Pi 5 with Docker".

.PHONY: up down logs build seed

# Start the app. Builds the images on first run, applies migrations, then serves
# on http://localhost:8080. Run `make seed` once after this to create the user.
up:
	docker compose up -d
	@echo ""
	@echo "  Open http://localhost:8080"
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
