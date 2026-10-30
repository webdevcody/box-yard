#!/bin/bash
# Prepares a Daytona sandbox for Box Yard, run through Daytona's toolbox on every new sandbox (as root, or with sudo
# when Daytona runs commands as another user, whose name is $1). Idempotent and quick when there's nothing to do.
# No watchdog and no key in here: Daytona's own auto-stop, set when Box Yard makes the sandbox, stops (and so
# deletes) a sandbox Box Yard has stopped touching.
set -euo pipefail
OWNER=${1:-root}

# The sandbox's GPU env for login shells, which may not keep it. Only these names: nothing else from Daytona's env.
{
  tr '\0' '\n' < /proc/1/environ 2>/dev/null | grep -E '^(NVIDIA_|CUDA_|LD_LIBRARY_PATH=)' | sed "s/'/'\\\\''/g; s/^\([^=]*\)=\(.*\)$/export \1='\2'/" || true
  echo "export IS_SANDBOX=1 DISABLE_AUTOUPDATER=1"
} > /etc/profile.d/boxyard.sh
chmod 644 /etc/profile.d/boxyard.sh

mkdir -p /box/.boxyard /box/tasks
touch /box/.heartbeat
[ "$OWNER" = root ] || chown -R "$OWNER" /box
git config --system init.defaultBranch main
echo "boxyard-init ok"
