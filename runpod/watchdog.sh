#!/bin/bash
# Dead-man switch: terminates this pod when no agent turn is running and Box Yard (which touches /box/.heartbeat on
# every command) hasn't been in touch for BOXYARD_POD_IDLE_MINUTES. It covers the computer running Box Yard
# sleeping or quitting while a pod is up. It uses the pod-scoped RUNPOD_API_KEY RunPod gives each pod, which can
# only act on this pod. /box/.keep-warm-until (epoch seconds) holds it off while a keep-warm is set.
IDLE_MIN=${BOXYARD_POD_IDLE_MINUTES:-30}
while sleep 60; do
  now=$(date +%s)
  beat=$(stat -c %Y /box/.heartbeat 2>/dev/null || echo "$now")
  until=$(cat /box/.keep-warm-until 2>/dev/null || echo 0)
  busy=0
  for f in /box/tasks/*/turn.pid; do [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null && busy=1; done
  if [ "$busy" = 0 ] && [ $((now - beat)) -gt $((IDLE_MIN * 60)) ] && [ "$now" -gt "$until" ]; then
    echo "$(date -u +%FT%TZ) idle for $(((now - beat) / 60)) min with no turn running: terminating pod $RUNPOD_POD_ID"
    if [ -n "${RUNPOD_API_KEY:-}" ] && [ -n "${RUNPOD_POD_ID:-}" ]; then
      curl -s -m 30 -X POST "https://api.runpod.io/v2/pods/$RUNPOD_POD_ID/action" \
        -H "Authorization: Bearer $RUNPOD_API_KEY" -H "Content-Type: application/json" -d '{"action":"terminate"}'
    fi
    sleep 300
  fi
done
