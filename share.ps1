$ErrorActionPreference = "Stop"

try {
    Invoke-RestMethod -Uri "http://127.0.0.1:8000/health" -TimeoutSec 3 | Out-Null
}
catch {
    Write-Error "The app is not running. Start it first with: python -m uvicorn app.main:app --reload"
    exit 1
}

$activeTunnel = $null
try {
    $tunnels = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 2
    $activeTunnel = $tunnels.tunnels |
        Where-Object { $_.proto -eq "https" } |
        Select-Object -First 1
}
catch {
    $activeTunnel = $null
}

if ($activeTunnel) {
    Write-Host "Public app link: $($activeTunnel.public_url)"
    Write-Host "Open it, create a meeting, then copy and share the participant link shown in the meeting."
    exit 0
}

$ngrok = Get-Command ngrok.cmd -ErrorAction SilentlyContinue
if (-not $ngrok) {
    Write-Error "ngrok is not installed or is not available on PATH."
    exit 1
}

Write-Host "Starting a temporary public tunnel. Keep this terminal open while participants join."
& $ngrok.Source http 127.0.0.1:8000
