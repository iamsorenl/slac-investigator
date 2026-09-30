FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv
# Hugging Face runs Spaces as uid 1000.
RUN useradd -m -u 1000 user
ARG REPO=https://github.com/iamsorenl/slac-investigator.git
ARG REF=main
RUN git clone --depth 1 --branch "$REF" "$REPO" /app && chown -R user /app
USER user
WORKDIR /app
ENV UV_PYTHON_DOWNLOADS=never
RUN uv sync --frozen
EXPOSE 7860
CMD ["sh", "deploy/hf/entrypoint.sh"]
