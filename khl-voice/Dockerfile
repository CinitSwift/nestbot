FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl jq ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /voice/entrypoint.sh
RUN chmod +x /voice/entrypoint.sh

ENTRYPOINT ["/voice/entrypoint.sh"]
