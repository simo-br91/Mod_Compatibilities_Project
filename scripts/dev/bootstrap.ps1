$ErrorActionPreference = "Stop"

Write-Host "Copying .env.example to .env when missing..."
if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
}

Write-Host "Phase 0 bootstrap complete."
Write-Host "Next steps:"
Write-Host "  1. pnpm install"
Write-Host "  2. docker compose up -d"
Write-Host "  3. pnpm contracts:check"

