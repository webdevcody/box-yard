#!/bin/bash
# Installs everything a Box Yard agent needs on a RunPod GPU pod. Idempotent: it does nothing when
# /opt/boxyard/ready already holds this script's version. The Dockerfile runs it at build time (so a pod from the
# custom image starts ready); without a custom image Box Yard runs it on each new pod over SSH (about a minute).
# Public: it must never contain or fetch a key or token.
set -euo pipefail
VERSION=1
if [ "$(cat /opt/boxyard/ready 2>/dev/null)" = "$VERSION" ]; then exit 0; fi
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
# Tools, sshd, and the GPU userspace headless Chrome needs. libegl1/libgl1/libgles2 are required: without the GLVND
# EGL loader Chrome can't make a WebGL context on the NVIDIA driver.
apt-get install -y -qq --no-install-recommends \
  openssh-server ca-certificates curl wget gnupg git git-lfs rsync tmux jq ripgrep zstd pigz procps psmisc unzip \
  build-essential pkg-config python3 python3-venv python3-pip python3-dev \
  ffmpeg xvfb mesa-utils libvulkan1 libegl1 libgl1 libgles2 \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libxshmfence1 fonts-liberation fonts-noto-color-emoji >/dev/null
apt-get install -y -qq libasound2t64 >/dev/null 2>&1 || apt-get install -y -qq libasound2 >/dev/null

# Node 24: Box Yard's runner and most repos.
if ! node --version 2>/dev/null | grep -q '^v24\.'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

# GitHub CLI.
if ! command -v gh >/dev/null; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq && apt-get install -y -qq gh >/dev/null
fi

# Google Chrome, for GPU-rendered headless browsing (ANGLE over the NVIDIA EGL driver).
if ! command -v google-chrome >/dev/null; then
  curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y -qq /tmp/chrome.deb >/dev/null && rm -f /tmp/chrome.deb
fi

# Claude Code and uv.
command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code >/dev/null 2>&1
command -v uv >/dev/null || (curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh >/dev/null)

rm -rf /var/lib/apt/lists/*
mkdir -p /opt/boxyard && echo "$VERSION" > /opt/boxyard/ready
