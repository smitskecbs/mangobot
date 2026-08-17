# ManGo production runbook (Hetzner)

Host path: `/home/adje/mangobot`  
Services: `mangobot.service`, `mango-highscore.service`  
User: `adje`

Do not enable presale from this runbook. Do not edit production `.env` unless you intend a config change. No destructive commands.

## Status

```bash
systemctl status mangobot.service --no-pager
systemctl status mango-highscore.service --no-pager
systemctl is-enabled mangobot.service mango-highscore.service
```

## Recent logs

```bash
journalctl -u mangobot.service -n 200 --no-pager
journalctl -u mango-highscore.service -n 200 --no-pager
journalctl -u mangobot.service -S "-1 hour" --no-pager
```

Useful log tags: `[startup]`, `[shutdown]`, `[crash]`, `[scheduler]`, `[wallet]`, `[presale]`, `[api]`, `[health]`.

## Restart (non-destructive)

```bash
sudo systemctl restart mangobot.service
sudo systemctl restart mango-highscore.service
```

## Health

API default port is `8787` unless `PORT` is set in `.env`.

```bash
curl -sS http://127.0.0.1:8787/health
```

Expect `presaleEnabled: false` unless you deliberately enabled it in `.env`. The body must not contain tokens, treasury keys, or Telegram ids.

## Git HEAD on the server

```bash
cd /home/adje/mangobot
git rev-parse --short HEAD
git status -sb
git log -1 --oneline
```

## Memory / process

```bash
systemctl show mangobot.service -p MemoryCurrent -p NRestarts -p ExecMainStatus -p ActiveEnterTimestamp
systemctl show mango-highscore.service -p MemoryCurrent -p NRestarts -p ExecMainStatus -p ActiveEnterTimestamp
ps -o pid,user,rss,etime,cmd -C node
```

`NRestarts` is the systemd restart counter for the current unit incarnation.

## How often systemd restarted the service

Since boot:

```bash
systemctl show mangobot.service -p NRestarts
systemctl show mango-highscore.service -p NRestarts
```

Restart history in the journal:

```bash
journalctl -u mangobot.service -b --no-pager | grep -E "Started|Stopped|Failed|Scheduled restart"
journalctl -u mango-highscore.service -b --no-pager | grep -E "Started|Stopped|Failed|Scheduled restart"
```

## Crash-loop policy (recommended, not applied from Cursor)

Both example units use:

- `Restart=on-failure`
- `RestartSec=5`
- `StartLimitIntervalSec=600`
- `StartLimitBurst=12`

Rationale: a genuine crash should be back in ~5s. Twelve starts in ten minutes covers a multi-minute Telegram outage without spinning thousands of times per minute. A permanent startup bug (`BOT_TOKEN` missing, syntax error) still hits the burst and stops.

If a unit is in `failed` after the limit:

```bash
systemctl reset-failed mangobot.service
sudo systemctl start mangobot.service
```

## Enable at boot (only when you are ready on the host)

```bash
sudo systemctl enable mangobot.service mango-highscore.service
```
