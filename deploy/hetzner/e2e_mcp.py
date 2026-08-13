#!/usr/bin/env python3
"""MCP tools/call smoke against a local or remote gateway.

CONARIUM_MCP_URL and CONARIUM_MCP_TOKEN are required. No secrets in-file.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request

URL = os.environ.get("CONARIUM_MCP_URL", "").rstrip("/")
TOKEN = os.environ.get("CONARIUM_MCP_TOKEN", "")


def rpc(method: str, params: dict, rid: int) -> dict:
    body = json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}).encode()
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {TOKEN}",
    }
    req = urllib.request.Request(URL, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=20) as res:
        raw = res.read().decode()
        if raw.startswith("event:"):
            for line in raw.splitlines():
                if line.startswith("data:"):
                    return json.loads(line[5:].strip())
        return json.loads(raw)


def main() -> int:
    if not URL or not TOKEN:
        print("CONARIUM_MCP_URL and CONARIUM_MCP_TOKEN are required", file=sys.stderr)
        return 2
    init = rpc("initialize", {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "conarium-e2e-mcp", "version": "0"},
    }, 1)
    print("initialize", "result" in init)
    listed = rpc("tools/list", {}, 2)
    names = [t.get("name") for t in (listed.get("result") or {}).get("tools") or []]
    print("tools", ",".join(names) or "(none)")
    return 0 if names else 1


if __name__ == "__main__":
    raise SystemExit(main())
