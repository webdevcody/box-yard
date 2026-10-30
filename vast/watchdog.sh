#!/bin/bash
# Dead-man switch: destroys this Vast.ai instance when no agent turn is running and Box Yard (which touches
# /box/.heartbeat on every command) hasn't been in touch for BOXYARD_POD_IDLE_MINUTES. It covers the computer running
# Box Yard sleeping or quitting while an instance bills. It uses the CONTAINER_API_KEY Vast gives each instance,
# which can only start, stop or destroy this one. /box/.keep-warm-until (epoch seconds) holds it off.
. /opt/boxyard/vast.env
IDLE_MIN=${BOXYARD_POD_IDLE_MINUTES:-30}
while sleep 60; do
  now=$(date +%s)
  beat=$(stat -c %Y /box/.heartbeat 2>/dev/null || echo "$now")
  until=$(cat /box/.keep-warm-until 2>/dev/null || echo 0)
  busy=0
  for f in /box/tasks/*/turn.pid; do [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null && busy=1; done
  if [ "$busy" = 0 ] && [ $((now - beat)) -gt $((IDLE_MIN * 60)) ] && [ "$now" -gt "$until" ]; then
    echo "$(date -u +%FT%TZ) idle for $(((now - beat) / 60)) min with no turn running: destroying instance $CONTAINER_ID"
    if [ -n "${CONTAINER_API_KEY:-}" ] && [ -n "${CONTAINER_ID:-}" ]; then
      curl -s -m 30 -X DELETE "https://console.vast.ai/api/v0/instances/$CONTAINER_ID/" -H "Authorization: Bearer $CONTAINER_API_KEY"
    fi
    sleep 300
  fi
done
