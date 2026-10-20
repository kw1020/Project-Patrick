#!/usr/bin/env bash
# Downloads the open-source tools Patrick Studio runs on and creates .env.
# Safe to re-run: existing downloads are updated, existing .env is kept.
set -euo pipefail
cd "$(dirname "$0")"

# Wired into Patrick and run by docker-compose.yml
CORE=(
  "mutonby/openshorts"                    # long video -> vertical clips (MIT)
  "gitroomhq/postiz-app"                  # scheduler for TikTok/Instagram/YouTube (AGPL-3.0)
  "gyoridavid/short-video-maker"          # script -> faceless short (MIT); runs from its Docker image
)
# Alternatives, downloaded for reference only (not run)
EXTRAS=(
  "SamurAIGPT/AI-Youtube-Shorts-Generator" # another long-video clipper
  "aceman23/pendpost-socialmedia-automation" # local-first planner with approval gate
  "post-bridge-hq/agent-mode"             # hosted posting service (paid)
  "taisly/agent"                          # hosted posting service
  "PostLake/postlake-mcp"                 # hosted posting service
)

mkdir -p vendor
fetch() {
  local repo=$1 dir="vendor/${2:-${1#*/}}"
  if [ -d "$dir/.git" ]; then
    echo "Updating $repo"
    git -C "$dir" pull --ff-only --quiet
  else
    echo "Downloading $repo"
    git clone --depth 1 --quiet "https://github.com/$repo.git" "$dir"
  fi
}
for r in "${CORE[@]}"; do fetch "$r"; done
if [ "${1:-}" != "--core" ]; then
  for r in "${EXTRAS[@]}"; do fetch "$r" "${r%%/*}-${r#*/}" || echo "  (skipped $r)"; done
fi

if [ ! -f .env ]; then
  cp .env.example .env
  secret() { head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40; }
  sed -i.bak "s|^POSTIZ_JWT_SECRET=.*|POSTIZ_JWT_SECRET=$(secret)|; s|^POSTIZ_DB_PASSWORD=.*|POSTIZ_DB_PASSWORD=$(secret)|" .env
  rm -f .env.bak
  echo
  echo "Created studio/.env. Fill in ANTHROPIC_API_KEY, PATRICK_PASSCODE, GEMINI_API_KEY and PEXELS_API_KEY,"
  echo "then run: docker compose up -d --build"
else
  echo "studio/.env already exists, left it alone."
fi
