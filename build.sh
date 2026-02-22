#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js 18+ from https://nodejs.org"
  exit 1
fi

echo "Installing dependencies..."
npm install

echo "Installing --save-dev electron-builder..."
npm install --save-dev electron-builder

echo "Building installers..."
npm run dist

echo "Done. Check dist/ folder."
