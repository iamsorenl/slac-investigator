#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# Provider keys are loaded by SuperLink's start.sh, not this frontend-facing API.
exec .venv/bin/uvicorn slac_assistant.api:create_app --factory --host 127.0.0.1 --port 8080 --workers 1 --no-proxy-headers --no-access-log
