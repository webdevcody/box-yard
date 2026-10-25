#!/bin/bash
# The custom image's entrypoint: SSH with the key Box Yard passes in PUBLIC_KEY, then init.sh, then wait.
mkdir -p /root/.ssh /run/sshd && chmod 700 /root/.ssh
[ -n "${PUBLIC_KEY:-}" ] && echo "$PUBLIC_KEY" > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
ssh-keygen -A >/dev/null 2>&1
/opt/boxyard/init.sh >> /box-init.log 2>&1 || true
/usr/sbin/sshd
sleep infinity
