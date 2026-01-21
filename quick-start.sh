#!/bin/bash

# Quick Start Script for Claude Code Chat Explorer
# Run this script after Docker gets reset or if the container is missing

set -e

echo "🔍 Checking Docker status..."

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Error: Docker is not running"
    echo "Please start Docker Desktop and try again"
    exit 1
fi

cd "$(dirname "$0")"

echo ""
echo "🔍 Checking if container exists..."

if docker ps -a --format '{{.Names}}' | grep -q '^claude-code-chat-explorer$'; then
    echo "✅ Container exists"

    if docker ps --format '{{.Names}}' | grep -q '^claude-code-chat-explorer$'; then
        echo "✅ Container is already running!"
        echo "📊 Access the web interface at: http://localhost:9876"
    else
        echo "🚀 Starting existing container..."
        docker compose up -d
        echo "✅ Container started!"
        echo "📊 Access the web interface at: http://localhost:9876"
    fi
else
    echo "📦 Container not found. Creating new container..."
    echo "🔨 Building container (this may take a minute)..."
    docker compose up -d --build
    echo ""
    echo "✅ Claude Code Chat Explorer is running!"
    echo "📊 Access the web interface at: http://localhost:9876"
fi

echo ""
echo "📝 Useful commands:"
echo "   View logs:    docker compose logs -f"
echo "   Stop:         docker compose down"
echo "   Restart:      docker compose restart"
echo ""
