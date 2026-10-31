# RunPod GPU pods

A project can run its agents on a RunPod GPU pod instead of an Upstash box or this computer: pick **Runs on: RunPod GPU** on the project's page. Use it for work that needs a real GPU, like WebGL games in headless Chrome, CUDA or ML. A project can run on [Vast.ai](vast.md) or [Daytona](daytona.md) instead (its GPU cloud in Project › Settings › Boxes).

## Setup (once per Box Yard install)

1. **API key.** Settings › RunPod GPU › API key, or set `RUNPOD_API_KEY` in Box Yard's environment. Make the key at runpod.io › Settings › API Keys.
2. **Image** (optional, but pods start much faster with it).
   - Settings › RunPod GPU › Image: type a repository you can push to, like `docker.io/<your-docker-user>/boxyard-gpu`, then press **Build & push**.
   - Box Yard runs `docker buildx build --platform linux/amd64 … --push runpod/` with your own Docker. It uses your own `docker login`; Box Yard never sees that login.
   - The tag is `bx-<hash of runpod/>`, so a change to the image files gives a new tag and no pod starts from a stale build.
   - The repository must be public, because RunPod pulls with no credentials. After the push, Box Yard checks that it can pull the image anonymously and warns if it can't.
   - The image holds only public tools. Before a build starts, Box Yard scans the files for anything shaped like a key and refuses to build if it finds one.
   - With no image, pods start from RunPod's stock PyTorch image (`RUNPOD_STOCK_IMAGE` in `shared/runpod.ts`). `bootstrap.sh` then installs the tools, which takes about a minute the first time a pod starts. Use the stock image when there's no Docker on the computer running Box Yard.
3. **GPU types**: an ordered list, A5000 then A40 by default. A pod gets the first type with stock that fits under the caps. The picker shows each type's VRAM, its live price on the chosen cloud, its stock and what it's good for (`RUNPOD_GPU_GUIDE` in `shared/runpod.ts`). For browser and WebGL game testing a cheaper one is plenty:

   | GPU (RunPod `gpuTypeId`) | VRAM | About | Good for |
   | --- | --- | --- | --- |
   | RTX 3070 (`NVIDIA GeForce RTX 3070`) | 8 GB | $0.13/hr, Community only | the cheapest browser/WebGL testing |
   | RTX A4000 (`NVIDIA RTX A4000`) | 16 GB | $0.17 Community, $0.25 Secure | browser/WebGL game testing |
   | RTX 4000 Ada (`NVIDIA RTX 4000 Ada Generation`) | 20 GB | $0.20 Community, $0.28 Secure | browser/WebGL games, light CUDA |
   | RTX A5000 (`NVIDIA RTX A5000`) | 24 GB | $0.16 Community, $0.27 Secure | games, mid-size models |
   | A40 / RTX A6000 | 48 GB | $0.33–0.59 | big models and datasets |

4. **Machine**: where pods run and the least host they take. A project can set each one for itself in Project › Settings › Boxes, or a Captain with `update_project` (`gpu_types`, `gpu_cloud`, `gpu_min_ram_gb`, `gpu_min_vcpus`). A change applies to new pods; running pods keep theirs.

   | Setting | Default | What it does |
   | --- | --- | --- |
   | Cloud | Secure | Secure Cloud is RunPod's own data centers, the only ones with network volumes. Community Cloud is cheaper and has more GPU types (the RTX 3070), but no volume, so every pod's caches start cold, and RunPod picks where it runs |
   | Min RAM | 24 GB | RunPod places the pod only on a host with at least this much RAM (`gpu.minRamPerGpu`). Cheap Community hosts can have little; a game's browser needs about 12 GB |
   | Min vCPUs | 8 | …and at least this many vCPUs (`gpu.minVcpuCountPerGpu`). The higher these are, the fewer hosts qualify |

5. **Limits**:

   | Setting | Default | What it does |
   | --- | --- | --- |
   | Idle stop | 10 min | Time with no task working before a pod is stopped |
   | Tasks running at once per pod | 3 | Tasks of one project that may run on one pod at once, unless the project sets Tasks running at once |
   | Max per project | $1/hr | Most one project's pods may cost together, unless the project sets its own GPU cap |
   | Max for all pods | $3/hr | Most all of this install's pods may cost together |
   | Network volume | 30 GB | Size of each project's volume (pod #1 only) |
   | Watchdog | 30 min | How long a pod waits with no contact from Box Yard before stopping itself |

## How it works

- **Pods per project.** Each of a GPU project's pods is a virtual box with at most one pod behind it.
  - Pod #1 is `runpod-<projectId>`, the one pod a project had before projects could have several. Pod #n is `runpod-<projectId>-<n>`.
  - Pods are named `boxyard-<install id>-<projectId>[-<n>]` and the volume `boxyard-<install id>-<projectId>`, so two Box Yards on one RunPod account never touch each other's.
  - A task takes the first of these that fits:
    1. its own pod while that's up, since its workspace is there;
    2. a free slot on another of its project's pods;
    3. a new pod, while the project has fewer than its **Max boxes** (20 when unset) and one more fits under the caps.
  - Slots per pod are the project's **Tasks running at once** (agents_per_box), else Tasks running at once per pod. With Tasks running at once 1 and Max boxes 4, four queued tasks get four pods.
- **Spending caps.** Before it counts on a new pod, Box Yard adds the pods' RunPod prices to the list price of the first of the project's GPU types that its cloud offers and that fits. A Community pod counts at the Community price. A pod still starting counts at that list price.
  - If that would go over the project's cap (Project › Settings › Boxes › GPU cap, `update_project gpu_max_hourly_usd`, else Max per project), the task waits. Its reason says so, e.g. `Waiting: RunPod cap $1/hr reached: game's 3 pods cost $0.81/hr and another RTX A5000 is $0.27/hr`.
  - The same happens at the total cap.
  - The reason shows on the task and in `pool_status`, and the project's Captain gets one notice.
  - `list_projects` and `pool_status` (`gpu_projects`) show each GPU project's pods, spend and caps. The pod start checks both caps again, one create at a time.
- **Starts on demand.** A task starts the pod. On Secure Cloud, Box Yard picks a data center that has stock of the project's GPU types and supports volumes, and makes the volume there once. On Community Cloud RunPod places the pod and there's no volume. Box Yard connects over SSH with its own key, kept in `<data dir>/runpod`.
- **Work survives a stop.** Task folders are archived after each turn, as on boxes, and restored when a new pod starts. Task folders live on each pod's container disk (`/box/tasks/<task>`), never on a shared working tree.
- **Only pod #1 mounts the volume.** `/workspace` on pod #1 is the project's network volume, which outlives the pod, so `/workspace/data` is a good place for caches. Pods #2 and up have no volume and keep their caches on their container disk.
  - RunPod lets a volume attach to several pods, but its docs warn that writing to one volume from several workers at once may corrupt data, and leave locking to the application.
  - Box Yard's caches on the volume (npm, pip, uv, Hugging Face, Playwright, the dependency cache) don't lock across machines, so a shared volume isn't safe for them.
  - Without a volume, an extra pod can also start in any data center with stock, not only the volume's.
- **Stops when idle.** A pod is terminated, not paused, so idle pods cost nothing. Each pod stops on its own when no task on it has worked for the idle-stop time, none of its own tasks waits, and nothing is keeping it warm. A project task waiting for any pod keeps a pod with a free slot up.
  - **Keep warm** (1h/4h in Settings › RunPod GPU) keeps a pod up for follow-up prompts.
  - **Stop** ends a pod right away.
  - **Dead-man switch.** If the computer running Box Yard sleeps or quits, the pod's own watchdog (`runpod/watchdog.sh`) terminates it after the watchdog time with no contact. It uses the pod-scoped key RunPod gives each pod.
- **Previews.** An agent's `$PORT` is reachable at `https://<podId>-<port>.proxy.runpod.net`.
- **Costs.** Pods bill by the second while they run. Volumes bill monthly whether or not a pod is up (about $0.07/GB a month). Delete a volume you no longer need in Settings › RunPod GPU › Volumes.

## Checking it works

`npm run smoke:runpod` (with `RUNPOD_API_KEY` set) starts one pod with the default settings and checks SSH, the tools, `nvidia-smi`, WebGL in headless Chrome on the NVIDIA GPU, files, and the proxy URL. Then it terminates the pod and deletes its volume. It takes about three minutes and costs about two cents. `--keep` leaves the pod up; `SMOKE_IMAGE=<your image>` tries a built image.

## Files

| Path | What |
| --- | --- |
| `runpod/` | The pod image: `Dockerfile`, `bootstrap.sh` (tools), `init.sh` (each start), `watchdog.sh`, `start.sh` |
| `server/runpod/api.ts` | RunPod REST client |
| `server/runpod/ssh.ts` | SSH to pods (ControlMaster, per-pod known_hosts) |
| `server/runpod/image.ts` | Image tag, key scan, Docker build and push, anonymous-pull check |
| `server/runpod/service.ts` | Settings, status, keep warm, volumes: what `/api/runpod` serves |
| `server/providers/runpod.ts` | The `BoxProvider` behind `runpod-*` boxes |
| `server/tasks.ts` | Placing tasks on their project's pods (`toGpu`, `gpuTarget`, `gpuCapBlock`), the idle sweep (`sweepGpuPods`) |
| `web/src/components/RunPodSettings.tsx` | Settings › RunPod GPU |
