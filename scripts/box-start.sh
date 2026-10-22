#!/usr/bin/env bash
# Starts (or restarts) Box Yard inside its Upstash Box. Used as the box's
# init command, so it runs again whenever the box resumes.
set -u
APP=/workspace/home/box-yard
LOG=/workspace/home/box-yard.log
cd "$APP" || exit 1
if [ -f box-yard.pid ] && kill -0 "$(cat box-yard.pid)" 2>/dev/null; then
  kill "$(cat box-yard.pid)" 2>/dev/null
  sleep 1
fi
nohup node dist/server/server/index.js >> "$LOG" 2>&1 < /dev/null &
echo $! > box-yard.pid
