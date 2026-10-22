#!/usr/bin/env bash
# Starts (or restarts) Box Yard inside its Upstash Box. Used as the box's
# init command, so it runs again whenever the box resumes.
# The pid file lives outside the app folder, because deploys replace that folder.
set -u
APP=/workspace/home/box-yard
LOG=/workspace/home/box-yard.log
PID=/workspace/home/box-yard.pid
cd "$APP" || exit 1
for f in "$PID" "$APP/box-yard.pid"; do
  if [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null; then kill "$(cat "$f")" 2>/dev/null; fi
done
# Anything else still holding the server (e.g. started by an older deploy).
pkill -f "node dist/server/server/index.js" 2>/dev/null
for i in $(seq 1 20); do pgrep -f "node dist/server/server/index.js" >/dev/null || break; sleep 0.5; done
pkill -9 -f "node dist/server/server/index.js" 2>/dev/null
nohup node dist/server/server/index.js >> "$LOG" 2>&1 < /dev/null &
echo $! > "$PID"
