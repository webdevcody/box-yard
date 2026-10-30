# Box Yard's Docker runner image (docs/docker.md): the tools agents need, so a project's container is ready seconds
# after it starts. Box Yard builds it on this computer (Settings › Docker › Build image, or the first task that needs
# it) and tags it with a hash of this folder, so any change here builds a new one. Multi-arch: arm64 Macs and amd64.
# It holds only public tools: never add a key, token, or an ARG/ENV that carries one. Credentials reach a container
# per turn, in memory only (a tmpfs), and never through the image, `docker run -e` or a command line.
FROM node:24-bookworm

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 IS_SANDBOX=1 DISABLE_AUTOUPDATER=1 \
    CHROME_PATH=/usr/bin/chromium PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Tools, build tools, and Chromium for browser tasks (Google Chrome has no arm64 Linux build; Debian's Chromium does).
RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends \
       sudo ca-certificates curl wget gnupg git git-lfs rsync tmux jq ripgrep zstd pigz procps psmisc unzip less \
       build-essential pkg-config python3 python3-venv python3-pip \
       chromium fonts-liberation fonts-noto-color-emoji >/dev/null \
  && install -d -m 0755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update -qq && apt-get install -y -qq gh >/dev/null \
  && rm -rf /var/lib/apt/lists/*

# The agent CLIs: Claude Code, and Codex for projects whose agents run on it (docs/codex.md).
RUN npm install -g @anthropic-ai/claude-code @openai/codex >/dev/null && npm cache clean --force >/dev/null

# The agent: node's uid 1000, renamed. Passwordless sudo works inside the container only (no host mounts, no Docker
# socket), so agents can apt-get what a task needs.
RUN usermod -l agent -d /home/agent -m node && groupmod -n agent node \
  && echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent && chmod 0440 /etc/sudoers.d/agent \
  && install -d -o agent -g agent /workspace /workspace/tasks /workspace/.boxyard /run/boxyard

# GitHub credentials come from the turn's $GITHUB_TOKEN only (gitconfig): no credential store, no ~/.git-credentials.
COPY gitconfig /etc/gitconfig

USER agent
WORKDIR /workspace
CMD ["sleep", "infinity"]
