#!/usr/bin/env bash
# HeatMind AI — one-command local start (macOS / Linux)
# Usage: ./start-dev.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

# --- Version checks -------------------------------------------------------
require_version() {
  local name="$1" have="$2" want_major="$3" want_minor="$4"
  local have_major have_minor
  have_major="$(echo "$have" | cut -d. -f1)"
  have_minor="$(echo "$have" | cut -d. -f2)"
  if (( have_major < want_major || (have_major == want_major && have_minor < want_minor) )); then
    echo "✗ $name $have found, but >=${want_major}.${want_minor} is required." >&2
    echo "  Next.js 16 will fail to start on an older Node, and the error it gives is not obvious." >&2
    exit 1
  fi
  echo "✓ $name $have"
}

command -v python3 >/dev/null || { echo "✗ python3 not found on PATH" >&2; exit 1; }
command -v node >/dev/null || { echo "✗ node not found on PATH" >&2; exit 1; }

PY_VERSION="$(python3 -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')"
NODE_VERSION="$(node -v | sed 's/^v//')"

require_version "Python" "$PY_VERSION" 3 11
require_version "Node" "$NODE_VERSION" 20 9

# --- Backend ---------------------------------------------------------------
if [ ! -d "$BACKEND/.venv" ]; then
  echo "Creating Python venv + installing backend deps..."
  python3 -m venv "$BACKEND/.venv"
  "$BACKEND/.venv/bin/python" -m pip install -q -r "$BACKEND/requirements.txt"
fi

# --- Frontend ----------------------------------------------------------------
if [ ! -d "$FRONTEND/node_modules" ]; then
  echo "Installing frontend deps (npm ci, using the committed lockfile)..."
  npm --prefix "$FRONTEND" ci
fi

# --- Launch ------------------------------------------------------------------
cleanup() {
  echo ""
  echo "Stopping HeatMind AI..."
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

"$BACKEND/.venv/bin/python" -m uvicorn app.main:app --port 8000 \
  --app-dir "$BACKEND" &
BACKEND_PID=$!

# --webpack works around a known Turbopack + native-addon (npm/cli#4828-adjacent)
# resolution bug; drop this flag once that's fixed upstream.
BACKEND_URL="http://localhost:8000" npm --prefix "$FRONTEND" run dev -- --webpack &
FRONTEND_PID=$!

echo ""
echo "HeatMind AI starting..."
echo "  App:      http://localhost:3000"
echo "  API docs: http://localhost:8000/docs"
echo ""
echo "Press Ctrl+C to stop both servers."

wait
