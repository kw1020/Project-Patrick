#!/bin/bash
# Mac launcher: double-click to start Patrick.
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Patrick needs Node.js to run. Opening the download page..."
  echo "Install the LTS version, then double-click Start Patrick again."
  open "https://nodejs.org/en/download"
  read -p "Press Enter to close."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Setting up Patrick for the first time. This takes about a minute..."
  npm install --no-audit --no-fund || { read -p "Setup failed. Press Enter to close."; exit 1; }
fi

# Add your API key on Patrick's Settings page (the gear button).
PATRICK_OPEN=1 node server.js
