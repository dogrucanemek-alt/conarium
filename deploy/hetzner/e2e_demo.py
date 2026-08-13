#!/usr/bin/env python3
"""Public-demo smoke: healthz + one MCP initialize.

The demo credential is published on the marketing site. It is still not
hardcoded here — set CONARIUM_DEMO_MCP_URL (full MCP endpoint).
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request

URL = os.environ.get("CONARIUM_DEMO_MCP_URL", "").rstrip("/")
TOKEN = os.environ.get("CONARIUM_DEMO_TOKEN", "")


def main() -> int:
    if not URL:
        print("CONARIUM_DEMO_MCP_URL is required", file=sys.stderr)
        return 2
    health = URL.rsplit("/mcp", 1)[0] + "/healthz" if URL.endswith("/mcp") else URL + "/healthz"
    with urllib.request.urlopen(health, timeout=15) as res:
        if res.status != 200:
            print(f"healthz {res.status}", file=sys.stderr)
            return 1
        print(f"healthz {res.status}")

    body = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "conarium-e2e-demo", "version": "0"},
        },
    }).encode()
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
    req = urllib.request.Request(URL, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=20) as res:
        raw = res.read().decode()
        print(f"initialize {res.status}")
        if res.status >= 400:
            print(raw[:300], file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
