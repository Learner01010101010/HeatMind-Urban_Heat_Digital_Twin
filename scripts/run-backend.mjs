#!/usr/bin/env node
// Cross-platform backend launcher.
//
// .claude/launch.json cannot name the venv interpreter directly: it lives at
// backend/.venv/Scripts/python.exe on Windows and backend/.venv/bin/python on
// macOS/Linux, and a launch config that hard-codes either one breaks the other.
// Node is already a hard requirement of this repo (frontend needs >= 20.9), so a
// tiny Node shim is the one launcher every contributor can run.
//
// Usage: node scripts/run-backend.mjs [--port 8000]
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  join(root, "backend", ".venv", "Scripts", "python.exe"), // Windows
  join(root, "backend", ".venv", "bin", "python"), // macOS / Linux
];

const python = candidates.find(existsSync);
if (!python) {
  console.error(
    "No virtualenv found. Create one first:\n" +
      "  cd backend && python -m venv .venv\n" +
      "  .venv/Scripts/python -m pip install -r requirements.txt     # Windows\n" +
      "  .venv/bin/python -m pip install -r requirements.txt         # macOS/Linux",
  );
  process.exit(1);
}

const portIdx = process.argv.indexOf("--port");
const port = portIdx !== -1 ? process.argv[portIdx + 1] : "8000";

const child = spawn(
  python,
  ["-m", "uvicorn", "app.main:app", "--app-dir", "backend", "--port", port],
  { cwd: root, stdio: "inherit" },
);

child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
