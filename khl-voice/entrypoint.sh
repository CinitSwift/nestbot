#!/bin/bash
set -u

API="https://www.kookapp.cn/api/v3"
AUTH="Bot ${TOKEN:-}"
CH="${CHANNEL:-}"
SRC="${SOURCE:-}"
REPEAT="${REPEAT:-false}"

if [ -z "${TOKEN:-}" ] || [ -z "$CH" ] || [ -z "$SRC" ]; then
  echo "[entrypoint] missing TOKEN/CHANNEL/SOURCE env"
  exit 1
fi

case "$SRC" in
  http://*|https://*)
    TMP="/tmp/khl-audio"
    echo "[entrypoint] downloading source ..."
    if curl -fsSL --retry 3 --retry-delay 1 --connect-timeout 10 --max-time 300 -o "$TMP" "$SRC" \
       && ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "$TMP" 2>/dev/null | grep -q '^audio'; then
      echo "[entrypoint] downloaded $(stat -c%s "$TMP") bytes, playing local file"
      SRC="$TMP"
    else
      echo "[entrypoint] download/probe failed, streaming source directly"
      rm -f "$TMP"
    fi
    ;;
esac

FF_PID=""

leave() {
  curl -s -X POST "$API/voice/leave" -H "Authorization: $AUTH" --data-urlencode "channel_id=$CH" >/dev/null 2>&1 || true
}

on_signal() {
  [ -n "$FF_PID" ] && kill "$FF_PID" 2>/dev/null
  leave
  exit 0
}
trap on_signal TERM INT

play_once() {
  local JOIN CODE IP PORT RMUX RPORT BPS SSRC PT URL KBPS i KA_PID
  for i in 1 2 3 4 5 6 7 8 9 10; do
    JOIN=$(curl -s -X POST "$API/voice/join" -H "Authorization: $AUTH" --data-urlencode "channel_id=$CH")
    CODE=$(echo "$JOIN" | jq -r '.code' 2>/dev/null)
    [ "$CODE" = "0" ] && break
    echo "[entrypoint] join attempt $i failed: $JOIN"
    sleep 2
  done
  if [ "$CODE" != "0" ]; then
    echo "[entrypoint] join failed permanently"
    return 1
  fi

  IP=$(echo "$JOIN" | jq -r '.data.ip // empty')
  PORT=$(echo "$JOIN" | jq -r '.data.port // empty')
  RMUX=$(echo "$JOIN" | jq -r '.data.rtcp_mux // true')
  RPORT=$(echo "$JOIN" | jq -r '.data.rtcp_port // empty')
  BPS=$(echo "$JOIN" | jq -r '.data.bitrate // 48000')
  SSRC=$(echo "$JOIN" | jq -r '.data.audio_ssrc // 1111')
  PT=$(echo "$JOIN" | jq -r '.data.audio_pt // 111')

  case "$BPS" in ''|*[!0-9]*) BPS=48000;; esac
  if [ -z "$IP" ] || [ -z "$PORT" ]; then
    echo "[entrypoint] invalid join data: $JOIN"
    return 1
  fi

  KBPS=$(( BPS / 1000 ))
  [ "$KBPS" -lt 8 ] && KBPS=48

  URL="rtp://$IP:$PORT"
  if [ "$RMUX" = "false" ]; then URL="$URL?rtcpport=$RPORT"; fi
  echo "[entrypoint] joined: $URL bitrate=${BPS}bps ssrc=$SSRC pt=$PT"

  ( while true; do
      sleep 45
      curl -s -X POST "$API/voice/keep-alive" -H "Authorization: $AUTH" --data-urlencode "channel_id=$CH" >/dev/null 2>&1 || true
    done ) &
  KA_PID=$!

  ffmpeg -hide_banner -loglevel level+info -nostats -re -i "$SRC" \
    -map 0:a:0 -acodec libopus -b:a "${KBPS}k" -ar 48000 -ac 2 -filter:a volume=0.8 \
    -f tee "[select=a:f=rtp:ssrc=$SSRC:payload_type=$PT]$URL" &
  FF_PID=$!
  wait "$FF_PID"
  local RC=$?
  FF_PID=""
  kill "$KA_PID" 2>/dev/null || true
  wait "$KA_PID" 2>/dev/null || true
  leave
  return $RC
}

if [ "$REPEAT" = "true" ]; then
  while true; do
    play_once || true
    sleep 3
  done
else
  play_once || exit 1
fi
