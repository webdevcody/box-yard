# Vast.ai GPU instances

Vast.ai is the second GPU cloud behind **Runs on: GPU**, beside [RunPod](runpod.md). It's a marketplace: hosts list their machines as offers, and Box Yard rents the cheapest one that fits a project's GPU types, minimums and $/hr caps. It usually has more GPU types and more stock than RunPod, often cheaper, but hosts vary in quality and there are no network volumes.

A GPU project runs on RunPod unless one of these says Vast.ai:

- the project's own **GPU cloud** (Project › Settings › Boxes, or a Captain's `update_project gpu_provider: "vast"`), or
- **Settings › Vast.ai GPU › Use for GPU projects**, for every GPU project that doesn't pick its own.

## Setup (once per Box Yard install)

1. **Credit.** Vast.ai is prepaid. Add credit at [cloud.vast.ai › Billing](https://cloud.vast.ai/billing/). Vast stops instances when the credit runs out, so the credit is a hard ceiling on spend. Box Yard's $/hr caps apply on top.
2. **API key.** Make one at [cloud.vast.ai › Keys](https://cloud.vast.ai/manage-keys/). Then either paste it in **Settings › Credentials › Vast.ai API key** (where **Test** checks it and shows your credit), or set `VAST_API_KEY` in Box Yard's environment. Box Yard only uses the key from the server; it never reaches an agent.
3. **Settings › Vast.ai GPU.** The defaults suit browser and WebGL game testing:

   | Setting | Default | What it does |
   | --- | --- | --- |
   | Use for GPU projects | off | GPU projects that don't pick a cloud run on Vast.ai |
   | Image | RunPod's | The image instances start from. Empty: the image built in Settings › RunPod GPU, else RunPod's stock PyTorch image (`bootstrap.sh` then installs the tools, a few minutes per new instance). It must be public |
   | GPU types | RTX A5000, RTX 3090, A40 | In order: an instance gets the cheapest offer of the first type that has one under the caps. The picker shows live offer counts and prices |
   | Verified hosts only | on | Only hosts Vast has verified |
   | Min RAM / Min vCPUs | 24 GB / 8 | The least host an offer may have. A project can set its own |
   | Min reliability | 0.95 | Vast's 0–1 score for the host |
   | Min download | 100 Mb/s | Images and repos come down at every start |
   | Disk | 40 GB | Each instance's disk, fixed when it's rented |
   | Idle stop | 10 min | Time with no task working before an instance is destroyed |
   | Tasks running at once per instance | 3 | Unless the project sets its own |
   | Max per project | $1/hr | Most one project's instances may cost together, unless the project sets its own GPU cap |
   | Max for all instances | $3/hr | Most all of this install's Vast.ai instances may cost together (RunPod's pods count toward RunPod's cap, not this one) |
   | Watchdog | 30 min | How long an instance waits with no contact from Box Yard before destroying itself |

4. **A project.** Make or open a GPU project, then in Project › Settings › Boxes set **GPU cloud** to Vast.ai, or turn on Use for GPU projects. Its GPU types and minimums there are Vast's when it's on Vast.ai.

GPU names are Vast's (`RTX A5000`, not RunPod's `NVIDIA RTX A5000`). A project that moves from RunPod keeps working: its RunPod GPU ids are read as Vast names.

| GPU | VRAM | About | Good for |
| --- | --- | --- | --- |
| RTX 3070 | 8 GB | ~$0.06–0.12/hr | the cheapest browser and WebGL testing |
| RTX A4000 | 16 GB | ~$0.10–0.20/hr | browser and WebGL game testing |
| RTX 3090 / RTX A5000 | 24 GB | ~$0.13–0.30/hr | games and mid-size models |
| RTX 4090 | 24 GB | ~$0.30–0.60/hr | fast CUDA |
| A40 / RTX A6000 | 48 GB | ~$0.30–0.70/hr | big models and datasets |

## How it works

- **Instances per project**, as RunPod's pods: instance #1 is `vastai-<projectId>`, #n is `vastai-<projectId>-<n>`. (`vastai-`, not `vast-`: Upstash names its own boxes like `vast-lobster`.) Each is labelled `boxyard-<install id>-<projectId>[-<n>]` at Vast, so two Box Yards on one account, or your own instances, are left alone. Placement, slots, Max boxes and the caps work as [on RunPod](runpod.md#how-it-works), and the wait reasons say `Vast.ai cap …`.
- **Renting.** Box Yard searches offers (one GPU, on demand, `POST /bundles/`), takes the cheapest of the project's first GPU type that fits under the room left in both caps, and rents it (`PUT /asks/<offer>/`). If an offer was taken in between, it tries the next. If Vast bills the instance above the caps, it's destroyed straight away. Rents happen one at a time, so two can't both squeeze under a cap.
- **SSH.** Box Yard's own key (in `<data dir>/vast`) is attached to each instance on its own (`POST /instances/<id>/ssh/`) and written in by the onstart script. Box Yard never adds keys to your Vast account. It SSHes straight to the host when port 22 is published, else through Vast's SSH proxy.
- **No volume.** Every instance starts cold. Workspaces are archived after each turn and restored on the next instance, as on boxes.
- **Destroyed when idle, never stopped.** A stopped Vast instance keeps no GPU and may never start again, so an idle instance is destroyed. Its disk goes with it. Keep warm (1h/4h in Settings › Vast.ai GPU) holds one up for follow-ups; **Terminate** ends one now. `delete_box` and `delete_idle_boxes` do the same safety checks as for RunPod pods: no running agent, every workspace archived first.
- **Dead-man switch.** If the computer running Box Yard sleeps or quits, the instance's watchdog (`vast/watchdog.sh`) destroys it after the watchdog time. It uses the instance-scoped key Vast gives each container, which can only manage that one instance.
- **Previews.** Vast has no HTTPS proxy. A task's first port (`$PORT`) is published straight from the host as `http://<host ip>:<host port>`: plain HTTP, reachable by anyone who has the URL. Other ports aren't reachable.
- **Spend.** `pool_status` (`gpu_projects`) shows each project's instances, spend and caps, and the cloud meter shows Vast.ai's total next to RunPod's.
- **Search quota.** Vast limits searches per day, so placement reuses a search for up to 3 minutes; renting always searches fresh.

## Caveats

- Hosts are third-party machines. Verified-only and the reliability floor help, but an instance can fail to start or disappear. Box Yard destroys a failed start and tries again on the next task.
- Prices are per host and move. The caps check the real price after renting.
- An instance stays billed for its disk while it exists; Box Yard never leaves stopped instances behind.

## Checking it works

`npm run smoke:vast` (with `VAST_API_KEY` set, and credit on the account) rents one instance with the default settings and checks SSH, the tools, `nvidia-smi`, WebGL in headless Chrome on the NVIDIA GPU, files, and the published port. Then it destroys the instance. It takes about five minutes and costs a few cents. `--keep` leaves the instance up; `SMOKE_IMAGE=<your image>` tries a built image. The tests (`test/vast.test.ts`, `test/vast-pods.e2e.test.ts`) never call Vast.ai.

## Files

| Path | What |
| --- | --- |
| `vast/` | `init.sh` (each start) and `watchdog.sh`. Tools come from `runpod/bootstrap.sh` or the built image |
| `server/vast/api.ts` | Vast.ai REST client |
| `server/vast/settings.ts` | Settings › Vast.ai GPU |
| `server/vast/service.ts` | Status, GPU options, keep warm: what `/api/vast` serves |
| `server/providers/vast.ts` | The `BoxProvider` behind `vastai-*` boxes |
| `server/providers/sshBox.ts` | Commands and files over SSH, shared with RunPod's provider |
| `shared/gpu.ts` | Box ids and the cloud a project uses |
| `web/src/components/VastSettings.tsx` | Settings › Vast.ai GPU |
