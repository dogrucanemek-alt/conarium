# Hetzner process scripts (sanitized)

These files lived only under `/opt/conarium-mcp` — a box death or an
overwrite had no git recovery. This directory is the repo copy.
**Secrets stay in env files on the box, never here.**

The live copies were not pulled in this change (Hetzner is patron-locked).
Scripts are reconstructed from the documented start path: source `.env.c*`,
then `node dist/http.js --config conarium.config.c*.json`. Ports below are
the ones the 2026-08-07 deploy probe used.

| Process (pm2) | Script | Config | Env file | Port |
|---|---|---|---|---|
| `conarium-mcp` | `start-c2.sh` | `conarium.config.c2.json` | `.env.c2` | **8792** |
| `conarium-demo` | `start-c3.sh` | `conarium.config.c3.json` | `.env.c3` | **8793** |

```bash
CONARIUM_ROOT=/opt/conarium-mcp
# pm2 start deploy/hetzner/start-c2.sh --name conarium-mcp --interpreter bash
```

Cron (not installed by git):

| Job | Script | When |
|---|---|---|
| Keep demo DB awake | `demo_keepalive.py` | `0 6,18 * * *` |
| Telegram on new demo audit lines | `demo_watch.py` | `*/10 * * * *` |

`e2e_demo.py` talks to the **published** demo endpoint. Set
`CONARIUM_DEMO_MCP_URL` (and `CONARIUM_DEMO_TOKEN` if the URL is not
already the capability token). Do not paste the token into the file.

## Rollback

```bash
cd /opt/conarium-mcp
git checkout -- deploy/hetzner
# then restart the pm2 process that uses the script you reverted
pm2 restart conarium-mcp   # or conarium-demo
```

This repo copy being present does **not** deploy it. Copying onto the box
is a separate patron step.

These files are **excluded from the npm tarball** (`files` deny
`deploy/hetzner/**`). Operators who install from npm do not need them.
