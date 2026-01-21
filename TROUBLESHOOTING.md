# Troubleshooting Guide

## No Conversations Showing

**Check conversations exist:**
```bash
find ~/.claude/projects -name "*.jsonl" | wc -l
```

**Check container logs:**
```bash
docker compose logs --tail=100
```

**Rebuild the database:**
```bash
docker compose down -v
docker compose up -d --build
```

## Container Crashes or Won't Start

**Check Docker is running:**
```bash
docker info
```

**View error logs:**
```bash
docker compose logs --tail=50
```

**Try a full rebuild:**
```bash
docker compose down
docker compose build --no-cache
docker compose up -d
```

## Port 9876 Already in Use

Edit `docker-compose.yml` and change the port:
```yaml
ports:
  - "9877:9876"  # Use 9877 on host
```

Then restart:
```bash
docker compose down
docker compose up -d
```

## WebSocket Not Connecting

The WebSocket connects to `/ws` on the same host. Check browser console for errors.

**Verify WebSocket is working:**
```bash
docker compose logs | grep -i websocket
```

You should see: `WebSocket server initialized on /ws`

## Search Not Working

Full-text search uses SQLite FTS5. If search returns no results:

1. Check the search query is not empty
2. Try simpler search terms
3. Rebuild the index:
   ```bash
   docker compose down -v
   docker compose up -d --build
   ```

## High Memory Usage

The container has a 1GB limit. If you see OOM errors:

1. Check how many conversations exist:
   ```bash
   find ~/.claude/projects -name "*.jsonl" | wc -l
   ```

2. The SQLite backend should handle 1000+ conversations efficiently. If issues persist, check logs for errors.

## Database Corruption

If you see SQLite errors, reset the database:
```bash
docker compose down -v  # Removes the volume
docker compose up -d --build
```

This will re-index all conversations from scratch.
