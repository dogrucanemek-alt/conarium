# Conarium anchoring service — deploy pack

This directory is the operator pack for self-hosting
`bin/conarium-anchor-service.mjs`. **Nobody has deployed this to Hetzner from
this tree.** Copy the files, fill `.env`, start it yourself.

Conarium is not the timestamp authority. The OpenTimestamps calendars and
Bitcoin are. This process countersigns each accepted hash, keeps an
append-only log, and stamps the log head. What that does and does not
prove: [`docs/COUNTERSIGN.md`](../../docs/COUNTERSIGN.md).

## What must be set

See `env.example`. The process **refuses to start** if any of these is
missing, and names the variable:

- `CONARIUM_ANCHOR_TOKENS` — path to a JSON map `{"token":"owner-id"}`
- `CONARIUM_ANCHOR_BASE_URL` — public origin used in verify URLs
- `CONARIUM_ANCHOR_SIGNING_KEY` — Ed25519 private PEM (sidecar `.keyid` or `CONARIUM_ANCHOR_KEY_ID`)

An anchoring endpoint anyone can write to is a disk filling up, not a service.
A countersign service without a key is not one. The public half is served at
`GET /anchor/key.pem` — a private PEM is refused with 403.

## Ports and health

| | default |
|---|---|
| listen | `127.0.0.1:8797` (`CONARIUM_ANCHOR_HOST` / `CONARIUM_ANCHOR_PORT`) |
| health | `GET /healthz` → `200` `{ ok: true, service: "conarium-anchor", anchors: N }` |

Put a TLS proxy in front. The process binds loopback on purpose.

`pm2 status` saying `online` is not proof it is listening. This box has already
had a process look healthy while binding nothing. Probe `/healthz`.

## Local dry-run (no calendars, no Hetzner)

From the repository root, after `npm run build`:

```bash
node deploy/anchor-service/dry-run.mjs
```

It asserts:

1. missing env → exit 2, the variable is named
2. tokens present but no signing key → exit 2, `CONARIUM_ANCHOR_SIGNING_KEY` is named
3. with throwaway tokens + key, `GET /healthz` returns 200
4. the process is then killed

`CONARIUM_ANCHOR_UPGRADE_MINUTES=0` so the dry-run never talks to a calendar.

## systemd

1. Copy `conarium-anchor.service` to `/etc/systemd/system/`
2. Edit `WorkingDirectory`, `User`, and `EnvironmentFile`
3. Copy `env.example` to `.env` and fill it
4. `systemctl daemon-reload && systemctl enable --now conarium-anchor`

## pm2

```bash
pm2 start deploy/anchor-service/ecosystem.config.cjs
pm2 save
```

Then: `curl -fsS http://127.0.0.1:8797/healthz`

## Rollback

1. Stop the unit / `pm2 stop conarium-anchor`
2. The store is append-only JSONL (`CONARIUM_ANCHOR_STORE`). Keep the file.
   Each line is a hash-chained, countersigned row (`seq` / `prevHash` / `hash`).
   A pending→bitcoin upgrade appends a new `type: 'upgrade'` line; the original
   submit line stays. An older binary that does not know `digest`/`seq` will
   not read this store correctly — do not mix versions against one file.
3. Do not rewrite the store to "fix" a proof. A store that can be rewritten
   is not an anchoring log. The process will refuse to serve a tampered file.

## Peer dependency

The OpenTimestamps client is built in (`src/ots/`). Calendars are reached
from the background tick (`runStamp` / `runUpgrade`), never from `POST /anchor`.
A calendar outage does not return 5xx on submit; the next tick retries the head.
`/healthz` does not stamp — a health probe does not depend on a calendar.
