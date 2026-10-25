# RunPod GPU pods

A project can run its agents on a RunPod GPU pod instead of an Upstash box or this computer: pick **Runs on: RunPod GPU** on the project's page. Use it for work that needs a real GPU, like WebGL games in headless Chrome, CUDA or ML.

## Setup (once per Box Yard install)

1. **API key.** Settings › RunPod GPU › API key, or set `RUNPOD_API_KEY` in Box Yard's environment. Make the key at runpod.io › Settings › API Keys.
2. **Image** (optional, but pods start much faster with it).
   - Settings › RunPod GPU › Image: type a repository you can push to, like `docker.io/<your-docker-user>/boxyard-gpu`, then press **Build & push**.
   - Box Yard runs `docker buildx build --platform linux/amd64 … --push runpod/` with your own Docker. It uses your own `docker login`; Box Yard never sees that login.
   - The tag is `bx-<hash of runpod/>`, so a change to the image files gives a new tag and no pod starts from a stale build.
   - The repository must be public, because RunPod pulls with no credentials. After the push, Box Yard checks that it can pull the image anonymously and warns if it can't.
   - The image holds only public tools. Before a build starts, Box Yard scans the files for anything shaped like a key and refuses to build if it finds one.
   - With no image, pods start from RunPod's stock PyTorch image (`RUNPOD_STOCK_IMAGE` in `shared/runpod.ts`). `bootstrap.sh` then installs the tools, which takes about a minute the first time a pod starts. Use the stock image when there's no Docker on the computer running Box Yard.
3. **GPU types**: an ordered list, A5000 then A40 by default. A pod gets the first type with stock that fits under the caps.
4. **Limits**:

   | Setting | Default | What it does |
   | --- | --- | --- |
   | Idle stop | 10 min | Time with no task working before a pod is stopped |
   | Agents per pod | 3 | Agents that share one pod |
   | Per-project cap | $1/hr | Most a project's pod may cost |
   | Total cap | $3/hr | Most all of this install's pods may cost together |
   | Network volume | 30 GB | Size of each project's volume |
   | Watchdog | 30 min | How long a pod waits with no contact from Box Yard before stopping itself |

## How it works

- **One pod per project.** Each GPU project has one virtual box, `runpod-<projectId>`, with at most one pod behind it. The pod and its network volume are named `boxyard-<install id>-<projectId>`, so two Box Yards on one RunPod account never touch each other's.
- **Starts on demand.** A task starts the pod. Box Yard picks a Secure Cloud data center that has stock of your GPU types and supports volumes. It makes the volume there once and connects over SSH with its own key, kept in `<data dir>/runpod`.
- **Work survives a stop.** Task folders are archived after each turn, as on boxes, and restored when a new pod starts. `/workspace` is the project's network volume, which also outlives the pod, so `/workspace/data` is a good place for caches.
- **Stops when idle.** A pod is terminated, not paused, so idle pods cost nothing. This happens when no task has worked for the idle-stop time and nothing is keeping it warm.
  - **Keep warm** (1h/4h in Settings › RunPod GPU) keeps a pod up for follow-up prompts.
  - **Stop** ends a pod right away.
  - **Dead-man switch.** If the computer running Box Yard sleeps or quits, the pod's own watchdog (`runpod/watchdog.sh`) terminates it after the watchdog time with no contact. It uses the pod-scoped key RunPod gives each pod.
- **Previews.** An agent's `$PORT` is reachable at `https://<podId>-<port>.proxy.runpod.net`.
- **Costs.** Pods bill by the second while they run. Volumes bill monthly whether or not a pod is up (about $0.07/GB a month). Delete a volume you no longer need in Settings › RunPod GPU › Volumes.

## Files

| Path | What |
| --- | --- |
| `runpod/` | The pod image: `Dockerfile`, `bootstrap.sh` (tools), `init.sh` (each start), `watchdog.sh`, `start.sh` |
| `server/runpod/api.ts` | RunPod REST client |
| `server/runpod/ssh.ts` | SSH to pods (ControlMaster, per-pod known_hosts) |
| `server/runpod/image.ts` | Image tag, key scan, Docker build and push, anonymous-pull check |
| `server/runpod/service.ts` | Settings, status, keep warm, volumes: what `/api/runpod` serves |
| `server/providers/runpod.ts` | The `BoxProvider` behind `runpod-*` boxes |
| `server/tasks.ts` | Placing tasks on their project's pod (`toGpu`), the idle sweep (`sweepGpuPods`) |
| `web/src/components/RunPodSettings.tsx` | Settings › RunPod GPU |
