#!/usr/bin/env python3
"""Keep the demo project's free-tier database from pausing.

URL and key come from the environment. No secrets in this file.
Cron (documented, not installed by this script): 0 6,18 * * *
"""
from __future__ import annotations

import os
import sys
import urllib.request

URL = os.environ.get("CONARIUM_KEEPALIVE_URL", "").rstrip("/")
KEY = os.environ.get("CONARIUM_KEEPALIVE_KEY", "")
PATH = os.environ.get("CONARIUM_KEEPALIVE_PATH", "/rest/v1/")


def main() -> int:
    if not URL or not KEY:
        print("CONARIUM_KEEPALIVE_URL and CONARIUM_KEEPALIVE_KEY are required", file=sys.stderr)
        return 2
    req = urllib.request.Request(
        URL + PATH,
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=20) as res:
        print(f"keepalive {res.status}")
        return 0 if 200 <= res.status < 300 else 1


if __name__ == "__main__":
    raise SystemExit(main())
