#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  Shiv Paneer Shawarma — dev control panel
#  Start the backend, the frontend, or both; view the database;
#  seed/reset; check status; tail logs; stop everything.
# ─────────────────────────────────────────────────────────────
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
VENV="$BACKEND/.venv"
PY="$VENV/bin/python"

PROJECT="shiv-paneer-shawarma"
EMU_HOST="localhost"; EMU_PORT=8081
API_PORT=8000
WEB_PORT=5500

RUNDIR="$ROOT/.dev"; mkdir -p "$RUNDIR"

# colours (fall back to empty if not a tty)
if [ -t 1 ]; then
  B=$'\e[1m'; DIM=$'\e[2m'; R=$'\e[0m'
  GRN=$'\e[32m'; RED=$'\e[31m'; YEL=$'\e[33m'; CYN=$'\e[36m'; ORG=$'\e[38;5;208m'
else B=""; DIM=""; R=""; GRN=""; RED=""; YEL=""; CYN=""; ORG=""; fi

say()  { printf "%s\n" "$*"; }
ok()   { printf "  ${GRN}✔${R} %s\n" "$*"; }
warn() { printf "  ${YEL}!${R} %s\n" "$*"; }
err()  { printf "  ${RED}x${R} %s\n" "$*"; }

# ── process helpers ───────────────────────────────────────────
pidfile() { echo "$RUNDIR/$1.pid"; }
logfile() { echo "$RUNDIR/$1.log"; }

alive() {  # alive <name>
  local pf; pf="$(pidfile "$1")"
  [ -f "$pf" ] || return 1
  local pid; pid="$(cat "$pf" 2>/dev/null)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

start_bg() {  # start_bg <name> <command...>
  local name="$1"; shift
  if alive "$name"; then return 0; fi
  setsid "$@" >"$(logfile "$name")" 2>&1 &
  echo $! > "$(pidfile "$name")"
}

stop_one() {  # stop_one <name>
  local pf; pf="$(pidfile "$1")"
  [ -f "$pf" ] || return 0
  local pid; pid="$(cat "$pf" 2>/dev/null)"
  if [ -n "$pid" ]; then
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    sleep 0.4
    kill -KILL "-$pid" 2>/dev/null || true
  fi
  rm -f "$pf"
}

port_up() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && exec 3>&- && return 0 || return 1; }

kill_port() {  # kill whatever is listening on a TCP port (servers started outside this panel)
  local port="$1" pids=""
  if command -v fuser >/dev/null 2>&1; then fuser -k "${port}/tcp" >/dev/null 2>&1 && return 0; fi
  if command -v ss >/dev/null 2>&1; then
    pids="$(ss -tlnpH "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u)"
  fi
  if [ -z "$pids" ] && command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti "tcp:$port" 2>/dev/null)"
  fi
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
}

# ── setup ─────────────────────────────────────────────────────
ensure_venv() {
  if [ ! -x "$PY" ]; then
    say "${DIM}First run: creating virtualenv and installing dependencies…${R}"
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install -q --upgrade pip
    "$VENV/bin/pip" install -q -r "$BACKEND/requirements.txt"
    ok "Dependencies installed."
  fi
  [ -f "$BACKEND/.env" ] || cp "$BACKEND/.env.example" "$BACKEND/.env"
}

# ── services ──────────────────────────────────────────────────
start_emulator() {
  if alive emulator || port_up "$EMU_PORT"; then ok "Database (emulator) already running on :$EMU_PORT"; return 0; fi
  say "  Starting Datastore emulator on :$EMU_PORT …"
  start_bg emulator gcloud beta emulators datastore start \
    --project="$PROJECT" --host-port="$EMU_HOST:$EMU_PORT" \
    --no-store-on-disk --consistency=1.0
  for _ in $(seq 1 60); do
    grep -q "is now running" "$(logfile emulator)" 2>/dev/null && break
    sleep 0.5
  done
  if grep -q "is now running" "$(logfile emulator)" 2>/dev/null; then ok "Database ready on :$EMU_PORT"
  else err "Emulator did not report ready — check: $(logfile emulator)"; fi
}

seed_db() {  # seed_db [--reset]
  ensure_venv; start_emulator
  say "  Seeding…"
  ( cd "$BACKEND" && "$PY" seed.py "${1:-}" )
}

seed_if_empty() {  # populate a fresh/empty database so the menu is never blank
  local n
  n="$( cd "$BACKEND" && "$PY" - <<'PY' 2>/dev/null
from app.db import db_context
from app.models import Category
with db_context():
    print(Category.query().count())
PY
)"
  if [ "${n:-0}" = "0" ]; then
    say "  Empty database — seeding starter menu…"
    ( cd "$BACKEND" && "$PY" seed.py >/dev/null 2>&1 ) && ok "Seeded menu + logins."
  fi
}

start_api() {
  ensure_venv; start_emulator; seed_if_empty
  if alive api || port_up "$API_PORT"; then ok "API already running on :$API_PORT"; return 0; fi
  say "  Starting API on :$API_PORT …"
  ( cd "$BACKEND" && start_bg api "$VENV/bin/uvicorn" app.main:app --host 127.0.0.1 --port "$API_PORT" )
  for _ in $(seq 1 40); do port_up "$API_PORT" && break; sleep 0.3; done
  port_up "$API_PORT" && ok "API ready → http://127.0.0.1:$API_PORT (docs at /docs)" || err "API failed — see $(logfile api)"
}

start_frontend() {
  if alive frontend || port_up "$WEB_PORT"; then ok "Frontend already running on :$WEB_PORT"; return 0; fi
  say "  Serving frontend on :$WEB_PORT …"
  ( cd "$FRONTEND" && start_bg frontend python3 -m http.server "$WEB_PORT" --bind 127.0.0.1 )
  for _ in $(seq 1 20); do port_up "$WEB_PORT" && break; sleep 0.2; done
  port_up "$WEB_PORT" && ok "Frontend ready → http://127.0.0.1:$WEB_PORT/index.html" || err "Frontend failed — see $(logfile frontend)"
}

stop_frontend() {
  stop_one frontend
  port_up "$WEB_PORT" && kill_port "$WEB_PORT"
  sleep 0.3
  port_up "$WEB_PORT" && err "Frontend still on :$WEB_PORT" || ok "Frontend stopped."
}

stop_api() {
  stop_one api
  port_up "$API_PORT" && kill_port "$API_PORT"
  sleep 0.3
  port_up "$API_PORT" && err "API still on :$API_PORT" || ok "Backend API stopped."
}

stop_database() {
  stop_one emulator
  # the emulator spawns a Java child; clean it up too
  pkill -f "CloudDatastore" 2>/dev/null || true
  port_up "$EMU_PORT" && kill_port "$EMU_PORT"
  sleep 0.3
  port_up "$EMU_PORT" && err "Database still on :$EMU_PORT" || ok "Database (emulator) stopped."
}

stop_all() {
  say "  Stopping services…"
  stop_frontend; stop_api; stop_database
}

stop_menu() {
  while true; do
    say ""
    say "  ${B}${RED}Stop services${R}"
    say "  ────────────────────────────────────────────"
    say "   1) Stop FRONTEND (website)"
    say "   2) Stop BACKEND (API)"
    say "   3) Stop DATABASE (emulator)"
    say "   4) Stop EVERYTHING"
    say "   0) Back"
    read -rp "  > " s || return
    case "$s" in
      1) stop_frontend; return;;
      2) stop_api; return;;
      3) stop_database; return;;
      4) stop_all; return;;
      0) return;;
      *) warn "Pick a number from the list.";;
    esac
  done
}

svc_line() {  # svc_line <label> <name> <port> <url>
  if alive "$2" || port_up "$3"; then printf "  %-20s ${GRN}● running${R}  ${DIM}%s${R}\n" "$1" "$4"
  else printf "  %-20s ${RED}○ stopped${R}\n" "$1"; fi
}

status() {
  say ""; say "  ${B}Status${R}"
  say "  ────────────────────────────────────────────"
  svc_line "Database (emulator)" emulator "$EMU_PORT" "127.0.0.1:$EMU_PORT"
  svc_line "Backend API"         api      "$API_PORT" "http://127.0.0.1:$API_PORT/docs"
  svc_line "Frontend site"       frontend "$WEB_PORT" "http://127.0.0.1:$WEB_PORT/index.html"
  say ""
}

open_browser() {
  local url="http://127.0.0.1:$WEB_PORT/index.html"
  say "  Customer : http://127.0.0.1:$WEB_PORT/index.html"
  say "  Staff    : http://127.0.0.1:$WEB_PORT/staff/login.html"
  say "  API docs : http://127.0.0.1:$API_PORT/docs"
  command -v xdg-open >/dev/null 2>&1 && xdg-open "$url" >/dev/null 2>&1 &
}

view_logs() {
  say ""
  say "  Which log?  1) API   2) Frontend   3) Database   0) Back"
  read -rp "  > " l || return
  case "$l" in
    1) tail -n 40 "$(logfile api)"      2>/dev/null || warn "no API log yet";;
    2) tail -n 40 "$(logfile frontend)" 2>/dev/null || warn "no frontend log yet";;
    3) tail -n 40 "$(logfile emulator)" 2>/dev/null || warn "no emulator log yet";;
    *) : ;;
  esac
}

# ── database submenu ──────────────────────────────────────────
db_view() { ensure_venv; start_emulator; ( cd "$BACKEND" && "$PY" inspect_db.py "$1" ); }

db_menu() {
  while true; do
    say ""
    say "  ${B}${CYN}Database${R}"
    say "  ────────────────────────────────────────────"
    say "   1) Summary (counts)"
    say "   2) View menu (categories & prices)"
    say "   3) View orders"
    say "   4) View users"
    say "   5) View coupons"
    say "   6) View everything"
    say "   ${DIM}—${R}"
    say "   7) Seed data (add if empty)"
    say "   8) ${YEL}Reset + reseed${R} (wipes all data)"
    say "   0) Back"
    read -rp "  > " d || return
    case "$d" in
      1) db_view summary;;
      2) db_view menu;;
      3) db_view orders;;
      4) db_view users;;
      5) db_view coupons;;
      6) db_view all;;
      7) seed_db;;
      8) read -rp "  This deletes all menu/orders/coupons. Type 'yes': " c; [ "$c" = "yes" ] && seed_db --reset || warn "Cancelled.";;
      0) return;;
      *) warn "Pick a number from the list.";;
    esac
  done
}

# ── main menu ─────────────────────────────────────────────────
header() {
  clear 2>/dev/null || true
  say "${ORG}${B}"
  say "   ┌────────────────────────────────────────────┐"
  say "   │      Shiv Paneer Shawarma · Dev Panel       │"
  say "   └────────────────────────────────────────────┘${R}"
  status
}

main_menu() {
  while true; do
    header
    say "  ${B}What would you like to run?${R}"
    say "   1) ${GRN}Start EVERYTHING${R}   (database + API + website)"
    say "   2) Start BACKEND only  (database + API)"
    say "   3) Start FRONTEND only (website)"
    say "   ${DIM}—${R}"
    say "   4) ${CYN}Database${R}  (view / seed / reset)"
    say "   5) Refresh status"
    say "   6) View logs"
    say "   7) Open in browser / show URLs"
    say "   8) ${RED}Stop${R} a service (frontend / backend / database / all)"
    say "   0) Exit  ${DIM}(services keep running in the background)${R}"
    say ""
    read -rp "  > " choice || { say ""; exit 0; }   # Ctrl-D / end of input exits cleanly
    case "$choice" in
      1) start_emulator; start_api; start_frontend; open_browser; pause;;
      2) start_emulator; start_api; pause;;
      3) start_frontend; pause;;
      4) db_menu;;
      5) : ;;
      6) view_logs; pause;;
      7) open_browser; pause;;
      8) stop_menu; pause;;
      0) say ""; say "  ${DIM}Tip: services still run in the background. Use option 8 to stop them.${R}"; exit 0;;
      q|Q) exit 0;;
      *) warn "Pick a number from the list."; sleep 1;;
    esac
  done
}

pause() { say ""; read -rp "  ${DIM}Press Enter to continue…${R} " _; }

# allow non-interactive shortcuts:  ./dev.sh start|backend|frontend|stop|status|db
case "${1:-menu}" in
  start|both) start_emulator; start_api; start_frontend; status;;
  backend)    start_emulator; start_api; status;;
  frontend)   start_frontend; status;;
  stop)
    case "${2:-all}" in
      frontend|web)      stop_frontend;;
      backend|api)       stop_api;;
      database|db|emulator) stop_database;;
      all|"")            stop_all;;
      *) say "Usage: ./dev.sh stop [frontend|backend|database|all]";;
    esac;;
  status)     status;;
  db)         db_view "${2:-summary}";;
  seed)       seed_db "${2:-}";;
  menu|"")    main_menu;;
  *)          say "Usage: ./dev.sh [start|backend|frontend|stop [target]|status|db|seed|menu]";;
esac
