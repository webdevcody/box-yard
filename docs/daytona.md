# Daytona sandboxes

Daytona is the third cloud behind **Runs on: GPU**, beside [RunPod](runpod.md) and [Vast.ai](vast.md). A project on Daytona gets managed sandboxes of its own: a GPU one (RTX 4090 up to B300), or a plain CPU one when the project doesn't need a GPU. Each starts when a task needs it and is deleted when idle. Daytona bills per second for the GPU, vCPUs, memory and disk a sandbox has while it runs.

A GPU project runs on RunPod unless one of these says otherwise:

- the project's own **GPU cloud** (Project › Settings › Boxes, or a Captain's `update_project gpu_provider: "daytona"`), or
- **Settings › Daytona › Use for GPU projects**, for every GPU project that doesn't pick its own. It wins over Vast.ai's when both are on.

## Daytona's GPUs

Per GPU-hour, from [daytona.io/pricing](https://www.daytona.io/pricing) (October 2026; `DAYTONA_GPU_GUIDE` in `shared/daytona.ts`):

| GPU (`gpuType`) | VRAM | On demand | Spot | Good for |
| --- | --- | --- | --- | --- |
| RTX 4090 (`RTX-4090`) | 24 GB | $0.99 | $0.57 | the cheapest: browser and WebGL game testing, mid-size models |
| RTX 5090 (`RTX-5090`) | 32 GB | $1.29 | $0.74 | fast CUDA, games and mid-size models |
| RTX PRO 6000 (`RTX-PRO-6000`) | 96 GB | $3.03 | $1.74 | big models and datasets |
| H100 | 80 GB | $3.95 | $2.27 | training and big models |
| H200 | 141 GB | $4.54 | $2.61 | training and the biggest models |
| B200 | 180 GB | $6.25 | $3.59 | large-scale training |
| B300 | 288 GB | $6.25 | $4.08 | large-scale training |
| MI355X | 288 GB | $5.99 | $3.44 | AMD: ROCm, not CUDA |

CPU, memory and disk cost $0.0504 per vCPU-hour, $0.0162 per GiB-hour of memory and $0.000108 per GiB-hour of disk (the first 5 GiB free).

What Daytona's docs say about GPU sandboxes:

- **Ephemeral.** A GPU sandbox must be made with `autoDeleteInterval: 0`, so stopping it deletes it. There is no stop and start, archive or fork, and nothing stays on its disk.
- **Size.** Up to 8 GPUs, and up to 16 vCPUs, 192 GiB memory and 512 GiB disk per GPU. They all run in Daytona's shared region (`earth`).
- **Quota.** On-demand GPUs have their own organization quota, which a new organization may not have yet ("Total GPU limit exceeded"). Free credits don't pay for GPUs: they need paid credit.
- **Stock.** With no free GPU of the asked-for types, an on-demand sandbox waits in `pending_build` until one is free. Spot (Tier 2 and up: a card and a $25 top-up) fails right away instead, and Daytona can take a spot GPU back without warning.
- **Availability.** The docs present GPU sandboxes as a normal feature, with no beta or waitlist label. Box Yard hasn't checked this live.

CPU sandboxes come out of the organization's pooled tier limits (Tier 1: 10 vCPUs, 10 GiB memory (20 in one of Daytona's tables) and 30 GiB disk across all running sandboxes) and a default per-sandbox limit of 4 vCPUs, 8 GiB memory and 10 GiB disk. A GPU sandbox's vCPUs, memory and disk don't count against the pool.

## Setup (once per Box Yard install)

1. **Credit.** Add credit in the Daytona dashboard (app.daytona.io) under Billing. GPUs need paid credit; the free credits don't cover them.
2. **API key.** Make one at [app.daytona.io › Keys](https://app.daytona.io/dashboard/keys) with only the **write:sandboxes** and **delete:sandboxes** permissions, and an expiry if you like. Box Yard needs nothing else. Paste it in **Settings › Credentials › Daytona API key**, where **Test** lists this install's sandboxes with it, or set `DAYTONA_API_KEY` in Box Yard's environment. Box Yard only uses the key from the server; it never reaches an agent or a sandbox.
3. **Settings › Daytona.** The defaults suit browser and WebGL game testing:

   | Setting | Default | What it does |
   | --- | --- | --- |
   | Use for GPU projects | off | GPU projects that don't pick a cloud run on Daytona |
   | GPU types | RTX 4090, RTX 5090 | Daytona's `gpuType`s in order of preference; Daytona gives the first one it has free. **CPU only** instead makes sandboxes with no GPU |
   | GPUs per sandbox | 1 | Each one is billed |
   | Spot GPUs | off | Cheaper, Tier 2 and up, and a spot GPU can be taken back at any moment, with the sandbox and its work. The workspace comes back from Box Yard's last archive |
   | GPU sandbox image | RunPod's | Empty: the image built in Settings › RunPod GPU, else RunPod's stock CUDA image |
   | CPU sandbox image | `ubuntu:24.04` | What CPU-only sandboxes start from |
   | GPU sandbox vCPUs / memory / disk | 8 / 32 GB / 60 GB | A project's own Min vCPUs and Min RAM replace the first two |
   | CPU sandbox vCPUs / memory / disk | 4 / 8 GB / 10 GB | Daytona's default per-sandbox limit |
   | Delete when idle | 10 min | Time with no task working or waiting before a sandbox is deleted |
   | Tasks running at once per sandbox | 3 | Unless the project sets its own |
   | Max per project | $3/hr | Most one project's sandboxes may cost together, unless the project sets its own GPU cap |
   | Max for all sandboxes | $6/hr | Most all of this install's Daytona sandboxes may cost together |
   | Auto-stop | 30 min | Daytona deletes a sandbox this long after Box Yard was last in touch (the dead-man switch) |
   | Wait for a GPU | 20 min | How long a new sandbox may take to build and get a GPU before Box Yard gives up |

   At the defaults a GPU sandbox is about $1.92/hr on an RTX 4090 and counts as $2.22/hr (see Spend), and a CPU-only one is about $0.33/hr.

4. **A project.** Make or open a GPU project, then set **GPU cloud** to Daytona in Project › Settings › Boxes, or turn on Use for GPU projects. Its GPU types there are Daytona's when it's on Daytona. A project that moves from RunPod or Vast.ai keeps working, because their names are read as Daytona's (`NVIDIA GeForce RTX 4090` becomes `RTX-4090`). A project whose types are all unknown to Daytona uses Settings › Daytona's.

## How it works

- **Sandboxes per project**, as RunPod's pods. Sandbox #1 is `daytona-<projectId>`, and #n is `daytona-<projectId>-<n>`. Each carries the labels `boxyard-install=<install id>` and `boxyard-box=<projectId>[-<n>]` at Daytona, so two Box Yards on one organization, or your own sandboxes, are left alone. Placement, slots, Max boxes and the caps work as [on RunPod](runpod.md#how-it-works).
- **Starting.** Box Yard makes the sandbox from a Dockerfile (`FROM <image>`) with the GPU types, GPUs, vCPUs, memory and disk set. It asks for `user: root`, and is private, ephemeral, and auto-stopped after Settings' Auto-stop.
  - Box Yard's public `runpod/bootstrap.sh` runs in the Dockerfile, so Daytona builds the tools into the image once, and later sandboxes of that image start ready. The first build takes a few minutes.
  - If Daytona can't build it (`build_failed`), Box Yard starts again from the plain image and runs `bootstrap.sh` in the sandbox.
  - `daytona/init.sh` then sets up `/box`.
  - Starts happen one at a time, so two can't both squeeze under a cap.
- **Commands and files** go through Daytona's toolbox API with the key; there's no SSH.
  - A command runs as `bash -lc` with its stderr kept apart.
  - A file is uploaded next to its place and moved in, so a reader never sees half of it.
  - Long output (workspace archives) goes to a file in the sandbox's `/tmp` first and then streams down, so it needs room there.
  - If Daytona runs commands as another user, Box Yard sets up through passwordless `sudo`.
- **No volume.** Every sandbox starts cold. Workspaces are archived after each turn and restored in the next sandbox, as on boxes. Project › Settings › Boxes has no snapshot for Daytona projects.
- **Deleted when idle.** An idle sandbox is deleted, and its disk goes with it.
  - **Keep warm** (1h/4h in Settings › Daytona) holds one up for follow-ups; it also lengthens Daytona's auto-stop to match.
  - **Terminate** ends one now.
  - `delete_box` and `delete_idle_boxes` do the same safety checks as for RunPod pods: no running agent, every workspace archived first.
- **Dead-man switch.** Daytona's auto-stop deletes a sandbox that hears nothing for Settings' Auto-stop time. Box Yard touches each running sandbox every 5 minutes, and a running turn's long toolbox call counts as contact too. So the auto-stop only fires when the computer running Box Yard sleeps or quits. Nothing in the sandbox holds a key.
- **Previews.** Each port gets its own signed URL.
  - It opens only that port and lapses after a day; Box Yard signs a new one an hour before then.
  - Box Yard never uses Daytona's plain preview token, which opens every port and the sandbox's toolbox and can't be revoked.
  - Anyone with a signed URL can open that port until it lapses.
- **Status.** Settings › Daytona lists this install's sandboxes. `pool_status` (`gpu_projects`) shows each project's sandboxes, spend and caps.

## Spend

- **Caps.** Max per project and Max for all sandboxes are checked before every start. A project's own GPU cap (Project › Settings › Boxes) replaces Max per project. Only GPU types that fit under the room left are asked for.
- **Estimates.** Daytona doesn't price a sandbox, so Box Yard counts each one at its worst. That is its dearest requested GPU type times its GPUs, plus its vCPUs, memory and disk at the CPU rates. The pricing page doesn't say whether a GPU's price includes the machine around it, so the estimate may be high, never low.
- **Daily cloud limit.** Unlike RunPod and Vast.ai, Daytona's sandboxes count toward **Settings › Usage › Daily cloud limit** and its other cloud limits.
  - Box Yard meters each running sandbox's estimate into the box usage every minute.
  - While a limit is reached, no new sandbox starts: the task waits with a **Raise the cloud limit** fix.
  - The provider checks it again just before it makes a sandbox.
  - Running sandboxes aren't stopped; they're deleted when idle as usual.

## Safety

- The client (`server/daytona/api.ts`) only calls sandbox-scoped endpoints:
  - make, list (by this install's label), read and delete sandboxes;
  - set a sandbox's auto-stop;
  - sign one port's preview URL;
  - run commands and move files in a sandbox.
- It never calls Daytona's account-wide endpoints: API keys, organizations, regions, runners, registries, secrets, warm pools, webhooks, users, or SSH access.
- The key is a credential (Settings › Credentials, `DAYTONA_API_KEY`). It's read on the server only. It isn't in any prompt, image, Dockerfile or sandbox env, and the error messages carry only the API path, never the host or key.

## Not done yet

- **Volumes.** Daytona volumes could keep caches between sandboxes, as RunPod's network volume does. Every sandbox starts cold for now.
- **Live GPU stock.** Daytona has a GPU capacity endpoint, but it's organization-scoped, so the picker shows list prices rather than stock.
- **Snapshots.** Sandboxes build from a Dockerfile each time (Daytona caches the build), not from a Daytona snapshot.
- **Real cost.** Spend is Box Yard's estimate, not Daytona's bill.

## Not yet checked against Daytona

The unit tests use a fake Daytona. These come from Daytona's docs and haven't been checked live; `npm run smoke:daytona` checks each:

- that `user: root` is honoured (else setup uses passwordless sudo);
- that a toolbox call stays open for minutes (a turn's hold and long installs use one call of up to 30 minutes);
- that a detached process outlives the command that started it (servers on preview ports);
- that 64 MB uploads go through (workspace archives);
- that the bake and fallback work with RunPod's stock image.

## Checking it works

`npm run smoke:daytona` makes one sandbox with the default settings and checks a set of things, then deletes the sandbox. It needs `DAYTONA_API_KEY` set and paid credit on the organization. It checks:

- the key, and that the sandbox starts;
- root, `nvidia-smi` and the tools;
- WebGL in headless Chrome on the NVIDIA GPU;
- files, a 64 MB upload and streamed output;
- a two-minute command and a detached process;
- the signed preview URL, and the auto-stop.

It spends money: about ten minutes of a GPU sandbox, roughly $0.50. `--cpu` tries a CPU-only sandbox instead. `--keep` leaves the sandbox up, and Daytona's auto-stop deletes it 20 minutes after the last contact. `SMOKE_IMAGE=<your image>` tries a built image.

The tests (`test/daytona.test.ts`, `test/daytona-pods.e2e.test.ts`) never call Daytona.

## Files

| Path | What |
| --- | --- |
| `daytona/init.sh` | Sets up `/box` in each new sandbox. Tools come from `runpod/bootstrap.sh` (built into the image, or run in the sandbox) |
| `server/daytona/api.ts` | Daytona REST and toolbox client (sandbox-scoped calls only) |
| `server/daytona/settings.ts` | Settings › Daytona |
| `server/daytona/service.ts` | Status, keep warm and the provider: what `/api/daytona` serves |
| `server/providers/daytona.ts` | The `BoxProvider` behind `daytona-*` boxes |
| `shared/daytona.ts` | GPU types and prices, the estimate, the settings |
| `shared/gpu.ts` | Box ids and the cloud a project uses |
| `web/src/components/DaytonaSettings.tsx` | Settings › Daytona |
| `scripts/smoke-daytona.ts` | `npm run smoke:daytona` |
