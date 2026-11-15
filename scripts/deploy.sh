#!/usr/bin/env bash
# Optional: deploy the committed HEAD to a Docker host over ssh. Usage: scripts/deploy.sh
# Needs DEPLOY_HOST (ssh host) and DEPLOY_URL (app base URL as the deploy machine reaches it, for the health check).
# Set them in the environment or in a git-ignored .deploy.env in the repo root.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .deploy.env ] && . ./.deploy.env
: "${DEPLOY_HOST:?set DEPLOY_HOST (ssh host) in the environment or in .deploy.env}"
: "${DEPLOY_URL:?set DEPLOY_URL (e.g. http://host:38080) in the environment or in .deploy.env}"
git archive --format=tar HEAD | ssh -o BatchMode=yes "$DEPLOY_HOST" 'mkdir -p ~/eve-mcp && tar -x -C ~/eve-mcp'
ssh -o BatchMode=yes "$DEPLOY_HOST" 'cd ~/eve-mcp && docker compose -p eve-mcp up -d --build'
for i in $(seq 1 30); do
  if curl -fsS "$DEPLOY_URL/health"; then echo; echo "deployed"; exit 0; fi
  sleep 2
done
echo "health check failed" >&2; exit 1
