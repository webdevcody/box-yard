#!/bin/bash
# Prepares a RunPod pod for Box Yard. start.sh runs it at boot in the custom image; Box Yard also runs it over SSH
# on every new pod (a stock image has no start.sh), so it must be idempotent and quick when there's nothing to do.
set -euo pipefail

# Many agents share one pod, and Box Yard multiplexes its commands over one SSH connection: allow many sessions.
CONF=/etc/ssh/sshd_config
if ! grep -q '^MaxSessions 200' "$CONF" 2>/dev/null; then
  sed -i '/^#\?MaxSessions/d; /^#\?MaxStartups/d' "$CONF"
  printf 'MaxSessions 200\nMaxStartups 100:30:200\n' >> "$CONF"
  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' "$CONF"
  pkill -HUP -o -x sshd 2>/dev/null || true
fi

# The pod's env (RUNPOD_POD_ID, GPU vars, …) for SSH sessions, which don't inherit it. The pod-scoped
# RUNPOD_API_KEY stays out: only the watchdog (a child of PID 1) has it.
{
  tr '\0' '\n' < /proc/1/environ | grep -E '^(RUNPOD_|NVIDIA_|CUDA_|LD_LIBRARY_PATH=|PUBLIC_KEY=|BOXYARD_)' | grep -vE '^(RUNPOD_API_KEY|PUBLIC_KEY)=' | sed "s/'/'\\\\''/g; s/^\([^=]*\)=\(.*\)$/export \1='\2'/"
  echo "export IS_SANDBOX=1 DISABLE_AUTOUPDATER=1"
  # Caches live on the network volume when one is mounted, so a new pod starts warm.
  echo 'if [ -d /workspace ]; then export npm_config_cache=/workspace/cache/npm PIP_CACHE_DIR=/workspace/cache/pip UV_CACHE_DIR=/workspace/cache/uv HF_HOME=/workspace/cache/huggingface PLAYWRIGHT_BROWSERS_PATH=/workspace/cache/ms-playwright; fi'
} > /etc/profile.d/boxyard.sh
chmod 644 /etc/profile.d/boxyard.sh

# Box Yard's box root on the fast container disk; the volume (NFS) only holds caches and data.
mkdir -p /box/.boxyard /box/tasks
if [ -d /workspace ]; then
  mkdir -p /workspace/cache/npm /workspace/cache/pip /workspace/cache/uv /workspace/cache/huggingface /workspace/cache/ms-playwright /workspace/data /workspace/deps
  # The dependency cache holds archives (big sequential files), which the volume handles well.
  [ -e /box/.boxyard/deps ] || ln -s /workspace/deps /box/.boxyard/deps
fi
touch /box/.heartbeat

# The money guard, once per pod.
if ! pgrep -f /opt/boxyard/watchdog.sh >/dev/null; then
  mkdir -p /opt/boxyard
  [ -f /opt/boxyard/watchdog.sh ] || cp "$(dirname "$0")/watchdog.sh" /opt/boxyard/watchdog.sh
  chmod +x /opt/boxyard/watchdog.sh
  # Started with PID 1's env so it has the pod-scoped RUNPOD_API_KEY, which SSH sessions don't.
  env -i $(tr '\0' '\n' < /proc/1/environ | grep -E '^(RUNPOD_API_KEY|RUNPOD_POD_ID|BOXYARD_POD_IDLE_MINUTES|PATH)=' | tr '\n' ' ') \
    setsid nohup /opt/boxyard/watchdog.sh >> /box/watchdog.log 2>&1 < /dev/null &
fi
git config --global init.defaultBranch main
echo "boxyard-init ok"
