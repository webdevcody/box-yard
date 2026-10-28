# Docker containers

A project can run its agents in a Docker container on the computer running Box Yard, instead of on an Upstash box, a RunPod pod, or straight on this computer: pick **Runs on: Docker container** on the project's page, or `runs_on: "docker"` for one task. Each Docker project gets one container of its own. Agents work inside it with only its workspace volume, and they can't see this computer's files, its other projects, or Docker itself.

Use it when you want the local runner's speed and price (free, no network hop) without an agent being able to touch the rest of the computer.

## Setup (once per Box Yard install)

1. **Docker.** Install Docker Desktop (or Docker Engine on Linux) and start it. Box Yard finds the `docker` CLI on the PATH or in Docker Desktop's usual places (`DOCKER_BIN` pins one). Settings › Docker shows whether it's running, and how many CPUs and how much memory it has for all containers.
2. **A Claude key.** Settings › Credentials › Claude, the project identity's Claude login (Settings › Identities), or `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` in the project's or the task's env. `claude setup-token` makes one. A container can't use this computer's own `claude` login, because macOS keeps it in the keychain and no host folder is mounted. Box Yard asks the same resolver that writes the turn's `task.json` (docs/identities.md), so a task waits for a key only when its turns really would have none.
3. **GitHub.** The same token boxes and pods get: Settings › Credentials › GitHub, or the project's own `GITHUB_TOKEN`. When Box Yard runs on this computer (Setup › Where agents run: This computer or Docker containers) and none is set, it uses this computer's `gh` login, as the local runner does.
4. **The image** (optional). The first task builds it, which takes a few minutes. **Settings › Docker › Build image now** builds it ahead of time.

Box Yard asks Docker for nothing until a project runs on Docker, so an install that doesn't use it never needs Docker running.

## Settings › Docker

| Setting | Default | What it does |
| --- | --- | --- |
| Image | Box Yard's | Blank: Box Yard's own image, built here from `docker/`. Or name an image of yours (it needs bash, node, git and claude), pulled when a container first needs it |
| CPUs per container | 2 | `docker run --cpus`: the most CPU one project's container may use. Its agents share it |
| Memory per container | 4096 MB | `--memory` (swap: as much again). On a Mac every container shares Docker Desktop's own memory (Docker Desktop › Settings › Resources), so keep this times the Docker projects in use within it. Settings warns when one container could take nearly all of it |
| Tasks running at once per container | 2 | Tasks of one project that run at once, unless the project sets its own **Tasks running at once** |
| Stop when idle | 30 min | A container with no agent running or waiting is stopped. Its volume keeps every workspace, and the next task starts it again in a few seconds. 0: never stop |
| Preview ports from | 47100 | The first port on this computer that previews take: 20 per container in a row |

A change to CPUs or memory applies to each container the next time it starts (`docker update`). The same settings are under `get_settings` / `update_settings` (`docker.*`) for the Coordinator.

A project can pick its own image in Project › Settings › Runs on:

- **Settings › Docker's image** (the default).
- **Its own image**: run as it is (it needs bash, node, git and claude).
- **Its own Dockerfile**: built on this computer with `ARG BOXYARD_BASE` set to the image above, so it can start `FROM ${BOXYARD_BASE}` and add what the project needs (the editor prefills that template). A Dockerfile wins over an image.

`update_project` sets the same thing with `docker: { image, dockerfile }`.

## How it works

- **One container per project.** A Docker project's box is the virtual `docker-<projectId>`, never a row in the boxes pool, so Max boxes, Max tasks running at once and box costs don't count it.
  - Its container is `boxyard-<install id>-<projectId>`. Its named volume is `boxyard-<install id>-<projectId>-work`, mounted at `/workspace`, and it holds the task folders, the repo mirrors and the dependency cache, as on a box.
  - Every container and volume carries the labels `boxyard=1`, `boxyard.install`, `boxyard.box`, `boxyard.project`, `boxyard.image` and `boxyard.ports`. Box Yard lists, stops and deletes only ones labelled with its own install id, and refuses to touch a container or volume that has one of its names but not its label. Your other containers and images are never touched.
- **Starts on demand.** A task starts its project's container (`wake`): it builds the image if needed, makes the volume, and runs the container with the image's user. It then checks that bash, node, git and claude are there, and sets git's name and email as on boxes.
  - Box history records each create, start, stop, delete and loss with an actor and a reason, under the box `Docker · <project>`.
  - A container whose image changed (an edit to `docker/` or the project's Dockerfile) is made again on its next start. The volume keeps every workspace; only what agents installed outside it (apt packages) goes.
- **Placement.** A task waits while its project's container is full (Tasks running at once per container, or the project's own Tasks running at once) and starts when a slot frees up.
  - A container holds up to 20 task folders, one preview port each. A 21st task parks the oldest resting folder in the archive store to make room, like a full box does.
- **Archives.** Task folders are archived after each turn as on boxes. A deleted container's tasks are restored from their archives into the next one.
- **Idle stop.** The minute sweep stops a container after **Stop when idle** with no agent running or waiting. Stopped containers cost nothing but disk. Settings › Docker › Containers lists each container with its state, its tasks and its ports, with **Stop** and **Delete…**. Delete archives every workspace first, then removes the container and its volume. On restore, pushed history comes back from GitHub and the rest from the archive.
  - `pool_status` lists them under `docker_projects`, and `delete_box` takes a `docker-<projectId>` box.
  - Deleting a project removes its container and volume.
- **No silent fallback.** When Docker isn't installed or isn't running, or there's no Claude key, a Docker task waits and its reason says why, e.g. `Waiting: Docker is installed but not running on the computer running Box Yard: start Docker Desktop…`. The project's Captain hears it once. The task never runs somewhere else. `create_tasks` with `runs_on: "docker"` on an install that can't use Docker fails with the same reason.
- **Previews.** Each task folder's `$PORT` (4000, 4010, … inside the container) is published on this computer's `127.0.0.1` only, at the container's block of 20 ports (47100-47119 for the first container). `report_preview` and `get_preview_url` give `http://localhost:<port>`. Serve on `$PORT`, bound to `0.0.0.0` inside the container. A container keeps its ports across stops, because its volume remembers them.

### Running commands: `docker exec`, not SSH

Box Yard runs every command with `docker exec -i <container> bash -c 'eval "$(cat)"'`, and the command itself goes in on stdin. SSH was the other option. `docker exec` is more robust here:

- **Nothing to set up or keep alive.** There's no sshd in the image, no host key, no `authorized_keys`, no port to publish, and no connection that drops when the Mac sleeps. A container that was stopped starts again when the next command needs it.
- **Nothing to steal.** There's no private key on this computer for the container, and no SSH port another process could reach.
- **No secret on a command line.** The command goes in on stdin, so `ps` on this computer, `docker events` and the daemon's logs never see a token.
- **The same shape as the other runners.** `exec`, streamed `exec`, file writes and uploads all go through `docker exec` with stdin, like `bash -c` on the local runner. Long turns use `hold`, which keeps a `docker exec` open and keeps a Mac awake (`caffeinate`) while an agent works.

## Credentials and isolation

- **In the container only, in memory only.** A turn's credentials (the Claude key, `GITHUB_TOKEN`, the project's env) reach the container in `task.json`, as on boxes. On Docker, `task.json` is written to a tmpfs (`/run/boxyard/<task>.json`, mode 0700, in the container's memory) and linked from the task folder. So is an identity's signing key (`/run/boxyard/<task>.signing.key`), which the runner keeps on the tmpfs while the turn signs and removes after (docs/identities.md).
  - Credentials are never in the image or a layer: the build context is only the Dockerfile, and a Dockerfile holding something shaped like a key, or any credential value in effect (Settings › Credentials and every identity's), is refused. The build log never shows one.
  - They're never in `docker run -e`, `docker inspect` or a command line.
  - The tmpfs is gone when the container stops or is deleted.
- **GitHub.**
  - `gh` reads `$GITHUB_TOKEN`.
  - git's credential helper (in the image's `/etc/gitconfig`, and in each repo's config) answers with the turn's `$GITHUB_TOKEN` and clears every other helper first, so no stored credential can answer before it.
  - Nothing writes a credential store or `~/.git-credentials`.
- **Mounts.** The only mount is the project's own volume: no folder of this computer, and no Docker socket. A container can't start other containers or reach the Docker daemon.
- **Inside the container.** Agents run as the image's user (`agent`, uid 1000, on Box Yard's image). It has passwordless sudo inside the container only, so agents can `apt-get` what a task needs. Limits: `--pids-limit 4096`, CPU and memory from Settings, and `/dev/shm` of 1 GB for Chromium.
- **Network.** Docker's default bridge network, so git, npm and the Claude API work. The container can reach the internet and anything this computer's network can.

## The image

Box Yard's image (`docker/`) is Debian (`node:24-bookworm`) with Node 24, git, git-lfs, gh, Claude Code, build tools (build-essential, Python 3), ripgrep, jq and Chromium (`CHROME_PATH`, `PUPPETEER_EXECUTABLE_PATH`). It's multi-arch: arm64 Macs and amd64.

- It's tagged `boxyard-agent:bx-<hash of docker/>`, so editing `docker/` builds a new image and containers move to it on their next start.
- It's built on this computer only, never pushed.
- A project's own Dockerfile builds `boxyard-project-<id>:bx-<hash of the Dockerfile and its base>`, built again when either changes.

## Checking it works

`npm run test:docker` runs `test/docker-real.e2e.test.ts` on this computer's Docker. It needs Docker running but no Claude key: the agent is `scripts/fake-claude.mjs`, copied into the container. The first run builds Box Yard's image (a few minutes, about 2 GB); after that it takes about 10 seconds. It starts a throwaway Box Yard with a Docker project and runs one task that writes a file and serves it on `$PORT`. It then checks:

- the image has node, git, gh, claude and Chromium;
- the preview answers on localhost;
- only the workspace volume is mounted, there is no Docker socket, and ports bind to 127.0.0.1 only;
- `task.json` is on the tmpfs and holds the project's `GITHUB_TOKEN`, while `docker inspect` and the image's history don't;
- a credential store in the container's own git config can't answer before the turn's `GITHUB_TOKEN` (F1);
- Stop keeps the workspace and drops the tmpfs;
- Delete removes the container and its volume, and box history reads created, stopped, started, deleted.

It leaves Box Yard's image for the next run. The unit tests (`test/docker-provider.test.ts`, against `test/fake-docker.mjs`) and the mock-mode end-to-end tests (`test/docker-runner.e2e.test.ts`) run with the rest of `npm test` and don't need Docker.

## Troubleshooting

| You see | Do |
| --- | --- |
| `Waiting: Docker isn't installed …` / `… not running …` | Start Docker Desktop. Tasks start within a few seconds of Docker answering |
| `Waiting: a Docker container can't use this computer's own claude login …` | Add a Claude key in Settings › Credentials or on the project's identity |
| A container stops with exit code 137, or agents get killed | It ran out of memory: raise Memory per container, and Docker Desktop's own memory if that's the limit |
| `No 20 free ports in a row from …` | Something else uses those ports: change Preview ports from |
| `The image … has no node` (or git, claude) | A project's own image needs bash, node, git and claude: build on Box Yard's with a Dockerfile instead |
| The first task takes minutes | The image is building: watch its log in Settings › Docker |

## Files

| Path | What |
| --- | --- |
| `docker/` | Box Yard's image: `Dockerfile`, `gitconfig` (git's system config) |
| `shared/docker.ts` | Settings, limits, box ids, project image types |
| `server/docker/engine.ts` | Finding Docker and whether it's running (`docker info`) |
| `server/docker/images.ts` | Image tags, builds (key scan, log), pulls |
| `server/docker/settings.ts` | Settings › Docker (kv `docker`) |
| `server/docker/service.ts` | Wires them together; what `/api/docker` serves |
| `server/providers/docker.ts` | The `BoxProvider` behind `docker-*` boxes: `docker run`, `exec`, files, previews, stop, delete, list |
| `server/providers/dockerFolders.ts` | Mock mode's stand-in: containers as folders |
| `server/tasks.ts` | Placing tasks (`dockerTarget`, `dockerAssign`), waits (`dockerWait`), the sweep (`sweepDocker`), deletes |
| `web/src/components/DockerSettings.tsx` | Settings › Docker |
