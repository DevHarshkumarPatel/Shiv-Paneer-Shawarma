#!/usr/bin/env bash
# Dev launcher: Datastore emulator + FastAPI backend + static frontend.
# Ctrl-C stops everything.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
PROJECT="shiv-paneer-shawarma"
EMU_HOSTPORT="localhost:8081"
API_PORT=8000
WEB_PORT=5500

pids=()
cleanup() { echo; echo "Stopping…"; for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; exit 0; }
trap cleanup INT TERM

# --- venv + deps ---
cd "$BACKEND"
if [ ! -d .venv ]; then
  echo "Creating virtualenv + installing dependencies…"
  python3 -m venv .venv
  ./.venv/bin/pip install -q --upgrade pip
  ./.venv/bin/pip install -q -r requirements.txt
fi
[ -f .env ] || cp .env.example .env

# --- Datastore emulator ---
echo "Starting Datastore emulator on $EMU_HOSTPORT …"
gcloud beta emulators datastore start --project="$PROJECT" \
  --host-port="$EMU_HOSTPORT" --no-store-on-disk --consistency=1.0 \
  > /tmp/sps-emulator.log 2>&1 &
pids+=($!)

# wait for the emulator health endpoint
for _ in $(seq 1 40); do
  if grep -q "is now running" /tmp/sps-emulator.log 2>/dev/null; then break; fi
  sleep 0.5
done

# --- seed ---
echo "Seeding menu + users…"
./.venv/bin/python seed.py || true

# --- API ---
echo "Starting API on :$API_PORT …"
./.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port "$API_PORT" > /tmp/sps-api.log 2>&1 &
pids+=($!)

# --- frontend ---
echo "Serving frontend on :$WEB_PORT …"
cd "$FRONTEND"
python3 -m http.server "$WEB_PORT" --bind 127.0.0.1 > /tmp/sps-web.log 2>&1 &
pids+=($!)

sleep 1
echo
echo "───────────────────────────────────────────────"
echo "  Customer : http://127.0.0.1:$WEB_PORT/index.html"
echo "  Staff    : http://127.0.0.1:$WEB_PORT/staff/login.html"
echo "  API docs : http://127.0.0.1:$API_PORT/docs"
echo "  Owner: owner@shivpaneer.com / owner123"
echo "───────────────────────────────────────────────"
echo "Logs: /tmp/sps-emulator.log  /tmp/sps-api.log  /tmp/sps-web.log"
echo "Press Ctrl-C to stop."
wait
