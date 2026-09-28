#!/usr/bin/env bash
# Start the Tauri development server on Linux.

set -euo pipefail

cd "$(dirname "$0")"

if ! command -v cargo >/dev/null 2>&1; then
  echo "Error: cargo not found. Install Rust from https://rustup.rs" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node not found. Install Node.js 20.19+ or 22.12+." >&2
  exit 1
fi

if ! cargo tauri --version >/dev/null 2>&1; then
  echo "Error: cargo-tauri is not installed." >&2
  echo 'Install it with: cargo install tauri-cli --version "^2"' >&2
  exit 1
fi

if [ ! -d frontend/node_modules ]; then
  echo "Installing frontend dependencies..." >&2
  npm install --prefix frontend
fi

exec cargo tauri dev "$@"
