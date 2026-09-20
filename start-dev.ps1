# HeatMind AI — one-command local start (Windows PowerShell)
# Usage:  powershell -ExecutionPolicy Bypass -File .\start-dev.ps1

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path "$root\backend\.venv")) {
  Write-Host "Creating Python venv + installing backend deps..."
  python -m venv "$root\backend\.venv"
  & "$root\backend\.venv\Scripts\python.exe" -m pip install -r "$root\backend\requirements.txt"
}
if (-not (Test-Path "$root\frontend\node_modules")) {
  Write-Host "Installing frontend deps..."
  npm --prefix "$root\frontend" install
}

Start-Process -FilePath "$root\backend\.venv\Scripts\python.exe" `
  -ArgumentList "-m", "uvicorn", "app.main:app", "--port", "8000" `
  -WorkingDirectory "$root\backend"
Start-Process -FilePath "npm.cmd" -ArgumentList "run", "dev" -WorkingDirectory "$root\frontend"

Write-Host ""
Write-Host "HeatMind AI starting..."
Write-Host "  App:      http://localhost:3000"
Write-Host "  API docs: http://localhost:8000/docs"
