# Quick Reference

## Common Commands

| Task | Command |
|------|---------|
| Start (first time or after reset) | `./quick-start.sh` |
| View dashboard | http://localhost:9876 |
| View logs | `docker compose logs -f` |
| Stop | `docker compose down` |
| Restart | `docker compose restart` |
| Rebuild | `docker compose up -d --build` |

## Auto-Start Behavior

| Scenario | Behavior |
|----------|----------|
| Docker restarts | Container auto-starts |
| Container crashes | Container auto-restarts |
| System reboots | Container auto-starts (if Docker auto-starts) |
| Manual stop | Stays stopped until started |
| Docker reset/reinstall | Run `./quick-start.sh` |

## Troubleshooting

**No conversations?**
```bash
find ~/.claude/projects -name "*.jsonl" | wc -l
```

**Container not running?**
```bash
docker compose ps
./quick-start.sh
```

**Check logs:**
```bash
docker compose logs --tail=50
```

**Port in use?** Edit `docker-compose.yml`:
```yaml
ports:
  - "9877:9876"
```

## File Locations

| Data | Location |
|------|----------|
| Claude conversations | `~/.claude/projects/` |
| SQLite database | Docker volume `chat-explorer-db` |
| Container logs | `docker compose logs` |
