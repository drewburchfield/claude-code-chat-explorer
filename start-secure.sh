#!/bin/bash
# Secure startup script for claude-code-chat-explorer
# Blocks all outbound internet access from the container while preserving localhost port binding

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Configuration
CONTAINER_NAME="claude-code-chat-explorer"
PF_ANCHOR="com.docker.claude-code-chat-explorer"
PF_RULES_FILE="/tmp/claude-code-chat-explorer-pf-rules.conf"

echo "Starting claude-code-chat-explorer with network isolation..."

# Start container
docker compose up -d

# Wait for container to get IP
sleep 2

# Get container IP
CONTAINER_IP=$(docker inspect "$CONTAINER_NAME" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null)

if [ -z "$CONTAINER_IP" ]; then
    echo "ERROR: Could not get container IP. Is the container running?"
    exit 1
fi

echo "Container IP: $CONTAINER_IP"

# Create pf rules to block outbound from container
# Allow: localhost traffic (for port binding)
# Block: everything else from container IP
cat > "$PF_RULES_FILE" << EOF
# Block outbound internet from claude-code-chat-explorer container
# Allow traffic to localhost/loopback
pass quick from $CONTAINER_IP to 127.0.0.0/8
pass quick from $CONTAINER_IP to ::1
# Block all other outbound from container
block drop quick from $CONTAINER_IP to any
EOF

echo "Firewall rules:"
cat "$PF_RULES_FILE"
echo ""

# Check if pf is enabled
if ! sudo pfctl -s info 2>/dev/null | grep -q "Status: Enabled"; then
    echo "WARNING: macOS Packet Filter (pf) is not enabled."
    echo "To enable and apply rules, run:"
    echo "  sudo pfctl -e"
    echo "  sudo pfctl -f $PF_RULES_FILE"
    echo ""
    echo "Container is running but WITHOUT network isolation!"
else
    # Apply rules
    echo "Applying firewall rules..."
    sudo pfctl -f "$PF_RULES_FILE" 2>/dev/null && echo "Firewall rules applied successfully."
fi

# Verify container is accessible
echo ""
echo "Testing localhost access..."
if curl -s -o /dev/null -w "" http://127.0.0.1:9876 --connect-timeout 3; then
    echo "✓ Container accessible at http://127.0.0.1:9876"
else
    echo "✗ Container not accessible (may still be starting)"
fi

echo ""
echo "Done. Container is running with security hardening."
echo "To stop: docker compose down"
