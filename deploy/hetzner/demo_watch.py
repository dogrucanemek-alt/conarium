#!/usr/bin/env python3
"""Watch the demo audit JSONL. On new lines, notify Telegram.

Token, chat id and audit path are environment variables. State file
stores only a line count. Cron (documented): */10 * * * *
"""
from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

AUDIT = Path(os.environ.get("CONARIUM_DEMO_AUDIT", "conarium-audit-c3.jsonl"))
STATE = Path(os.environ.get("CONARIUM_DEMO_WATCH_STATE", ".demo_watch_state"))
TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CHAT = os.environ.get("TELEGRAM_CHAT_ID", "")


def http_only(url: str) -> str:
    """urllib opens file:// too. The scheme is allowlisted rather than
    trusted, so a mangled token or base can never turn this into a reader
    of local files."""
    if not url.startswith(("https://", "http://127.0.0.1", "http://localhost")):
        sys.exit(f"refusing non-http(s) URL: {url[:24]!r}")
    return url


def main() -> int:
    if not TOKEN or not CHAT:
        print("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required", file=sys.stderr)
        return 2
    if not AUDIT.is_file():
        print(f"no audit yet: {AUDIT}")
        return 0
    lines = AUDIT.read_text(encoding="utf-8").splitlines()
    n = len(lines)
    prev = int(STATE.read_text(encoding="utf-8").strip() or "0") if STATE.is_file() else 0
    if n <= prev:
        STATE.write_text(str(n) + "\n", encoding="utf-8")
        return 0
    added = n - prev
    text = f"conarium demo audit: {added} new line(s) (total {n})"
    body = urllib.parse.urlencode({"chat_id": CHAT, "text": text}).encode()
    req = urllib.request.Request(
        http_only(f"https://api.telegram.org/bot{TOKEN}/sendMessage"),
        data=body,
        method="POST",
    )
    # http_only() above is the brake; annotated with a reason, not silenced.
    # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
    with urllib.request.urlopen(req, timeout=20) as res:
        json.loads(res.read().decode())
    STATE.write_text(str(n) + "\n", encoding="utf-8")
    print(f"notified {added}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
