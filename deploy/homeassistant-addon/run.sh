#!/usr/bin/with-contenv bashio
set -euo pipefail

token_file=/data/agent-token
if [[ ! -s "${token_file}" ]]; then
  umask 077
  openssl rand -hex 32 > "${token_file}"
fi

export PORT="$(bashio::config 'port')"
export FILEMANAGER_LISTEN_HOST="$(bashio::config 'listen_host')"
export FILEMANAGER_MODE=agent
export FILEMANAGER_ROOT=/host
export FILEMANAGER_DISPLAY_ROOT=/
export FILEMANAGER_AGENT_TOKEN_FILE="${token_file}"

exec node /app/src/server.js

