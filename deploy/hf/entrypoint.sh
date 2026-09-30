#!/bin/sh
# Hugging Face Space entrypoint: grid in the background, public API in the foreground on 7860.
set -eu
cd /app
: "${FLWR_MODEL_API_KEY:?Space secret FLWR_MODEL_API_KEY is missing}"
: "${INVESTIGATOR_VISITOR_SALT:?Space secret INVESTIGATOR_VISITOR_SALT is missing}"
# start_flower.py reads the model key from a private .env (owner-only, mode 600).
umask 077
printf 'FLWR_MODEL_API_ENDPOINT=%s\nFLWR_MODEL_API_KEY=%s\nINVESTIGATOR_MODEL=%s\n' \
  "${FLWR_MODEL_API_ENDPOINT:-https://api.groq.com/openai/v1/responses}" "$FLWR_MODEL_API_KEY" \
  "${INVESTIGATOR_MODEL:-openai/gpt-oss-20b}" > .env
unset FLWR_MODEL_API_KEY   # the API process never needs it
scripts/start_grid.sh &
exec .venv/bin/uvicorn slac_assistant.api:create_app --factory --host 0.0.0.0 --port 7860 \
  --workers 1 --no-proxy-headers --no-access-log
