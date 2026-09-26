#!/usr/bin/env pwsh
# Start Tauri development server

Set-Location $PSScriptRoot

Write-Host "Starting Tauri dev server..." -ForegroundColor Green

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Host "Error: cargo not found. Please install Rust." -ForegroundColor Red
    exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Error: node not found. Please install Node.js 20.19+ or 22.12+." -ForegroundColor Red
    exit 1
}

$cargoTauriVersion = cargo tauri --version 2>$null
if (-not $cargoTauriVersion) {
    Write-Host "Error: cargo-tauri is not installed." -ForegroundColor Red
    Write-Host "Install it with: cargo install tauri-cli --version `"^2`"" -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "frontend\node_modules"))) {
    Write-Host "Installing frontend dependencies..." -ForegroundColor Cyan
    npm install --prefix frontend
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

cargo tauri dev
