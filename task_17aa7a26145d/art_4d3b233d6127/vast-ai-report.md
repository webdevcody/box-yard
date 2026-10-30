# Vast.ai as a second GPU cloud for Box Yard: research and feasibility

**Verdict: feasible, and close to the RunPod runner.** Vast.ai has a plain REST API with Bearer API keys. Through it you can search GPU offers by GPU, RAM, vCPU, disk, price and reliability, create an instance from any Docker image with an onstart script, SSH in as root, and destroy it. Box Yard can drive this the way it drives RunPod: one instance per project slot, reused while busy, destroyed when idle, with $/hr caps enforced by Box Yard. Vast has no spend cap of its own.

What's different from RunPod: it's a marketplace of other people's hosts. Prices are per host, offers vanish, and reliability varies. There's no network volume. Previews are plain `http://ip:port`. You must enforce every spend limit yourself.

## 1. API and auth
- REST at `https://console.vast.ai/api/v0`, with `Authorization: Bearer <key>` ([auth](https://docs.vast.ai/api-reference/authentication), [intro](https://docs.vast.ai/api-reference/introduction)).
- Keys are made at <https://cloud.vast.ai/manage-keys/>. They don't expire, and can be scoped to permission groups such as `instance_read`, `instance_write` and `user_read` ([permissions](https://docs.vast.ai/api-reference/permissions), [keys](https://docs.vast.ai/guides/reference/api-keys)).
- There's an official Python CLI/SDK, `vastai` ([vast-cli](https://github.com/vast-ai/vast-cli)), and no official JS SDK, so Box Yard uses a small `fetch` client like `server/runpod/api.ts`.
- Rate limits are per endpoint and give HTTP 429 ([rate limits](https://docs.vast.ai/api-reference/rate-limits-and-errors)). The client code also shows a **daily search quota** (`search_quota_exceeded` until UTC midnight, [client.py](https://github.com/vast-ai/vast-cli/blob/master/vastai/api/client.py)), so offer searches must be cached.

## 2. Finding and renting a GPU
- **Search:** `POST /api/v0/bundles/` with a query of operators (`eq gte lte in …`) on `gpu_name` ("RTX A5000", with spaces), `num_gpus`, `cpu_ram` (**MB**), `cpu_cores_effective`, `disk_space` (GB), `dph_total` ($/hr), `reliability`, `verified`, `rentable`, `direct_port_count`, `inet_down`, `type: "on-demand"`, plus `order` and `limit` ([search offers](https://docs.vast.ai/api-reference/search/search-offers), [query.py](https://github.com/vast-ai/vast-cli/blob/master/vastai/api/query.py)).
- **Create:** `PUT /api/v0/asks/{offer id}/` with `{ image, disk, runtype: "ssh_direct", env: { KEY: val, "-p 4000:4000": "1" }, onstart, label }`. It returns `{ success, new_contract: <instance id> }` ([create instance](https://docs.vast.ai/api-reference/instances/create-instance), [creating instances](https://docs.vast.ai/api-reference/creating-instances-with-api)).
- **Show / stop / destroy:**
  - `GET /api/v0/instances/{id}/` returns `actual_status`, `ssh_host`/`ssh_port`, `public_ipaddr`, `ports`, `dph_total` and `label`.
  - `PUT /api/v0/instances/{id}/` with `{"state":"stopped"}` stops one.
  - `DELETE /api/v0/instances/{id}/` destroys one.
  - Sources: [show](https://docs.vast.ai/api-reference/instances/show-instance), [manage](https://docs.vast.ai/api-reference/instances/manage-instance), [destroy](https://docs.vast.ai/api-reference/instances/destroy-instance).
- A **stopped** instance keeps no GPU and may wait in "Scheduling" forever when restarted ([manage instances](https://docs.vast.ai/guides/instances/manage-instances)). So Box Yard destroys idle instances rather than stopping them, as it terminates RunPod pods.
- Boot is "typically 1–5 minutes", mostly the image pull ([hello world](https://docs.vast.ai/api-reference/hello-world)).

## 3. Image, onstart, SSH and ports
- **Image:** any public image works, and private ones via `image_login` ([template settings](https://docs.vast.ai/guides/templates/template-settings)). In SSH mode Vast **replaces the entrypoint** with its own SSH setup, then runs `onstart` (at most 4048 chars, saved as `/root/onstart.sh`, run on every start) ([connect](https://docs.vast.ai/guides/instances/connect/overview), [docker env](https://docs.vast.ai/guides/instances/docker-environment), [FAQ](https://docs.vast.ai/guides/reference/faq/instances)). Box Yard's RunPod image (or RunPod's stock Ubuntu image) fits.
- **SSH keys:** the documented ways are an account key (`POST /api/v0/ssh/`) or a key **attached to one instance** (`POST /api/v0/instances/{id}/ssh/`) ([attach](https://docs.vast.ai/api-reference/instances/attach-ssh-key)). Box Yard attaches its own key per instance and never touches the account's keys, the same rule as RunPod's.
- SSH goes **direct** (`public_ipaddr` plus the host port mapped to 22) or through a **proxy** (`sshN.vast.ai:port`) ([SSH](https://docs.vast.ai/guides/instances/connect/ssh)). Box Yard prefers direct and falls back to the proxy.
- **Ports:** `-p N:N` in `env` maps each to a random public port, at most 64 per instance; `VAST_TCP_PORT_N` holds it inside ([networking](https://docs.vast.ai/guides/instances/connect/networking)). There's no RunPod-style HTTPS proxy: previews are `http://<ip>:<port>` on hosts with direct ports, or a Cloudflare tunnel ([instance portal](https://docs.vast.ai/guides/instances/connect/instance-portal)).
- **Self-destroy from inside:** each container gets `CONTAINER_ID` and an instance-scoped `CONTAINER_API_KEY` that can only start, stop or destroy that instance ([hello world](https://docs.vast.ai/api-reference/hello-world), [docker env](https://docs.vast.ai/guides/instances/docker-environment)). That gives the dead-man watchdog the RunPod runner already has.

## 4. Storage and billing
- **Billing model:** per second, from prepaid credit ([pricing](https://docs.vast.ai/guides/instances/pricing)).
- **What's charged:** GPU while running; disk every second the instance exists, stopped too; bandwidth per GB ([billing FAQ](https://docs.vast.ai/guides/reference/faq/billing), [billing](https://docs.vast.ai/guides/reference/billing)). Disk size is fixed at create.
- **Instance types:** on-demand, interruptible (a bid; stopped when outbid) and reserved (prepaid, up to 50% off) ([instance types](https://docs.vast.ai/guides/instances/choosing/instance-types)). Box Yard uses **on-demand only**.
- **Volumes:** local to one machine ([volumes](https://docs.vast.ai/guides/instances/storage/volumes)), so there's no shared cache volume like RunPod's Secure Cloud one. Every instance starts cold, and workspaces restore from Box Yard's archives as on RunPod pods #2+.

## 5. Spend caps
- **Vast has none:** no spend limit, budget or auto-destroy on create ([full docs](https://docs.vast.ai/llms-full.txt)). There's only a low-balance email or webhook ([notifications](https://docs.vast.ai/guides/reference/notifications)).
- At $0 balance, instances stop. **With a saved card and auto-billing, Vast keeps charging** ([billing](https://docs.vast.ai/guides/reference/billing)).
- **What Box Yard enforces itself:**
  - $/hr per project and in total, checked before each create and again on the instance's real price;
  - Max boxes per project;
  - idle destroy after 10 min;
  - an in-instance watchdog that destroys it after 30 min with no contact from Box Yard;
  - destroying any instance that fails to start.
- **Suggested for Cody:** keep prepaid credit, no auto-billing, and set Vast's low-balance alert.

## 6. Compared with the RunPod runner (#132, `server/runpod/*`, `server/providers/runpod.ts`)

| | RunPod (today) | Vast.ai |
| --- | --- | --- |
| API | REST v2, Bearer key | REST v0, Bearer key |
| Picking a GPU | `gpuTypeId` + cloud; RunPod places it | Search offers per host, pick the cheapest that fits, rent that offer id |
| Price | List price per GPU type | Per offer (`dph_total`), varies by host |
| SSH key | `PUBLIC_KEY` env at create | Attach to the instance after create (plus onstart) |
| Entrypoint | Image's own (`start.sh`) | Replaced by Vast's SSH setup, then `onstart` |
| Previews | `https://<pod>-<port>.proxy.runpod.net` | `http://<ip>:<mapped port>` |
| Volume | Network volume on Secure Cloud | None that follows the project |
| Watchdog | Pod-scoped `RUNPOD_API_KEY` | Instance-scoped `CONTAINER_API_KEY` |
| Spend caps | Box Yard's | Box Yard's (Vast has none) |
| Availability | GPU types per data center | Many more hosts and GPU types (RTX 3090/4090 and more) |

## 7. How it fits Box Yard
- **Same code path:**
  - Runs on stays **GPU** (`runs_on: "gpu"`), and the cloud is a setting: the project's own pick (Project › Settings › Boxes, `update_project gpu_provider`), else the global one (Settings › Vast.ai GPU › "Use Vast.ai for GPU projects").
  - Vast instances are virtual boxes `vastai-<project>[-n]`, placed, capped, idle-swept and deleted through the same TaskManager code as `runpod-*` pods.
  - SSH reuses `server/runpod/ssh.ts` (ControlMaster, per-host known_hosts, Box Yard's own key).
- **RunPod is unchanged.** Its pods, settings, caps and image keep working as before.

## Main caveats
1. **No spend cap at Vast:** Box Yard's caps and watchdog are the only guard, and prepaid credit bounds the worst case.
2. **Marketplace hosts:** prices and reliability vary, and offers can vanish between search and rent. Box Yard filters on verified hosts, reliability ≥ 0.95 and at least 100 Mb/s download, and tries the next offer.
3. **No cache volume:** each instance starts cold (npm, pip, browsers).
4. **Previews are plain HTTP** on a host port, only on hosts with direct ports.
5. **The docs contradict themselves in places:** `env` object vs string, `ondemand` vs `on-demand`, and the `ports` shape. I went with what the official CLI sends. A one-off live check (`npm run smoke:vast`, a few cents) should confirm before relying on it. I did **not** run anything live.
6. **Daily search quota:** offer searches are cached for a few minutes.
