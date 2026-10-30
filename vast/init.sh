#!/bin/bash
# Prepares a Vast.ai instance for Box Yard, run over SSH on every new instance (after the onstart script Box Yard
# rents it with, which lets Box Yard's key in and starts the watchdog). Idempotent and quick when there's nothing to do.
set -euo pipefail

# Many agents share one instance, and Box Yard multiplexes its commands over one SSH connection: allow many sessions.
CONF=/etc/ssh/sshd_config
if [ -f "$CONF" ] && ! grep -q '^MaxSessions 200' "$CONF"; then
  sed -i '/^#\?MaxSessions/d; /^#\?MaxStartups/d' "$CONF"
  printf 'MaxSessions 200\nMaxStartups 100:30:200\n' >> "$CONF"
  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' "$CONF"
  pkill -HUP -o -x sshd 2>/dev/null || true
fi

# The container's env (GPU vars, CONTAINER_ID, …) for SSH sessions, which don't inherit it. The instance-scoped
# CONTAINER_API_KEY stays out: only the watchdog reads it (/opt/boxyard/vast.env, root only).
{
  tr '\0' '\n' < /proc/1/environ | grep -E '^(NVIDIA_|CUDA_|LD_LIBRARY_PATH=|CONTAINER_ID=|VAST_|PUBLIC_IPADDR=)' | grep -vE '^(CONTAINER_API_KEY|VAST_API_KEY)=' | sed "s/'/'\\\\''/g; s/^\([^=]*\)=\(.*\)$/export \1='\2'/"
  echo "export IS_SANDBOX=1 DISABLE_AUTOUPDATER=1 NVIDIA_DRIVER_CAPABILITIES=all NVIDIA_DISABLE_REQUIRE=1"
} > /etc/profile.d/boxyard.sh
chmod 644 /etc/profile.d/boxyard.sh

# Vast logs SSH sessions into tmux unless this file exists.
touch /root/.no_auto_tmux
mkdir -p /box/.boxyard /box/tasks
touch /box/.heartbeat
git config --global init.defaultBranch main
echo "boxyard-init ok"
