#!/usr/bin/env bash
# Deploy Box Yard to any Linux server you can SSH into, with Docker.
#
#   ./yard deploy-vps root@1.2.3.4
#
# Copies the app and your .env, installs Docker if needed, and runs
# `docker compose up -d --build`. Data lives in the box-yard-data volume.
# Set BOXYARD_DOMAIN in .env (and point DNS at the server) for HTTPS via Caddy.
set -euo pipefail

TARGET="${1:-}"
DIR="${2:-box-yard}"
if [ -z "$TARGET" ]; then
  echo "usage: ./yard deploy-vps user@host [remote-dir]" >&2
  exit 1
fi
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "Create .env first (cp .env.example .env)." >&2; exit 1; }
# The container listens on 0.0.0.0, and with no password Box Yard refuses to start there (server/bind.ts), as it
# does with a weak one (server/password.ts). Check here, not in a container that restarts forever.
command -v node >/dev/null || { echo "Install Node.js 20+ first (it checks your password): https://nodejs.org" >&2; exit 1; }
set +e
# The container runs as root, so that username is refused too.
npx tsx scripts/password.ts check --user root
pw_status=$?
set -e
if [ "$pw_status" -eq 2 ] && grep -q '^BOXYARD_ALLOW_OPEN=1' .env; then
  echo "  (BOXYARD_ALLOW_OPEN=1: deploying with no login.)"
elif [ "$pw_status" -eq 2 ]; then
  echo "✗ Without BOXYARD_PASSWORD anyone who finds the server can use it, so Box Yard won't start there." >&2
  echo "  (Behind your own auth proxy? Set BOXYARD_ALLOW_OPEN=1 instead.)" >&2
  exit 1
elif [ "$pw_status" -ne 0 ]; then
  exit 1
fi

PROFILE=""
if grep -q '^BOXYARD_DOMAIN=..*' .env; then PROFILE="--profile https"; fi

echo "▸ Copying the app to $TARGET:~/$DIR"
ssh "$TARGET" "mkdir -p ~/$DIR"
if command -v rsync >/dev/null; then
  rsync -az --delete --exclude node_modules --exclude dist --exclude data --exclude .git --exclude .env ./ "$TARGET:~/$DIR/"
else
  tar czf - --exclude node_modules --exclude dist --exclude data --exclude .git --exclude .env . | ssh "$TARGET" "tar xzf - -C ~/$DIR"
fi
scp -q .env "$TARGET:~/$DIR/.env"

echo "▸ Building and starting with Docker"
ssh "$TARGET" bash -s <<REMOTE
set -euo pipefail
if ! command -v docker >/dev/null; then
  echo "  installing Docker…"
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
cd ~/$DIR
docker compose $PROFILE up -d --build
docker compose ps
REMOTE

HOST="${TARGET#*@}"
DOMAIN="$(grep '^BOXYARD_DOMAIN=' .env | cut -d= -f2- || true)"
echo
echo "✓ Box Yard is running: ${DOMAIN:+https://$DOMAIN}${DOMAIN:-http://$HOST:3000}"
