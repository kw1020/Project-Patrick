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

if [ ! -f .env ]; then
  echo
  echo "Paste your Anthropic API key and press Enter."
  echo "(Get one at console.anthropic.com. Leave it blank to try demo mode.)"
  read -p "API key: " KEY
  if [ -n "$KEY" ]; then echo "ANTHROPIC_API_KEY=$KEY" > .env; else : > .env; fi
fi

PATRICK_OPEN=1 node server.js
