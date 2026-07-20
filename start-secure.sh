#!/bin/bash
# Secure startup script for claude-code-chat-explorer.
# Network isolation is declared in docker-compose.yml; this script deliberately
# does not modify the host's macOS PF rules.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Starting claude-code-chat-explorer with network isolation..."

docker compose up -d --build

# Verify container is accessible without exposing transcript data.
echo ""
echo "Testing localhost access..."
if curl -fsS -o /dev/null http://127.0.0.1:9876/healthz --connect-timeout 3; then
    echo "✓ Container accessible at http://127.0.0.1:9876"
else
    echo "✗ Container not accessible (may still be starting)"
fi

echo ""
echo "Done. Container is running with Docker-managed network isolation."
echo "Authenticated access URL (also available in container logs):"
docker compose logs --tail=30 chat-explorer | grep "Local access:" || true
echo "To stop: docker compose down"
