"""Outside-in check with only the public key: an anonymous caller must not read any table.

Run after 0001_schema.sql:  python supabase/tests/anon_probe.py
"""
import sys
from pathlib import Path

import requests

env = dict(line.split("=", 1) for line in (Path(__file__).parents[2] / ".env").read_text().splitlines()
           if "=" in line and not line.startswith("#"))
URL, KEY = env["SUPABASE_URL"].strip(), env["SUPABASE_PUBLISHABLE_KEY"].strip()
TABLES = ["profiles", "settings", "holdings", "watchlist", "push_subscriptions", "telegram_link_codes",
          "alerts_log", "recommendations", "prices", "index_snapshots", "announcements", "worker_runs"]

leaks = 0
for t in TABLES:
    r = requests.get(f"{URL}/rest/v1/{t}?select=*&limit=1", headers={"apikey": KEY}, timeout=20)
    body = r.text[:120].replace("\n", " ")
    blocked = r.status_code in (401, 403) or (r.status_code == 200 and r.text.strip() == "[]")
    exists = r.status_code != 404 and '"PGRST205"' not in r.text
    if not exists:
        status, leaks = "MISSING (schema not applied?)", leaks + 1
    elif r.status_code in (401, 403):
        status = "blocked"
    elif blocked:
        status = "empty"
    else:
        status, leaks = "LEAK", leaks + 1
    print(f"{t:<22} HTTP {r.status_code}  {status:<30} {body if status != 'blocked' else ''}")

print("\nANON PROBE:", "PASS" if leaks == 0 else f"FAIL ({leaks} tables missing or readable)")
sys.exit(1 if leaks else 0)
