# SSH machines

Box Yard can run agents on computers of your own that it reaches over SSH: an old laptop, a GPU tower, a Mac mini in a cupboard. A machine is used like a box. Box Yard logs in, makes a folder for the task, clones the repo with the project's GitHub token, runs Claude Code headless with the same MCP bridge, streams its output, archives the workspace, pushes the branch and opens the PR, as it does on Upstash boxes.

Give machines **labels** (`laptops`, `gpu`, `local`). A project that runs on "SSH machine", or a task with `runs_on: "label:gpu"`, goes to a free machine with that label. Tasks wait while every matching machine is busy.

> **Agents on an SSH machine are not sandboxed.** They run as the user Box Yard logs in as, with that user's files and network. Give Box Yard a user account of its own on each machine.

## Set up an old laptop

These steps are for Ubuntu or Debian; [macOS](#macos-machines) differs only a little. Run them on the laptop unless a step says otherwise.

1. **SSH and a user for Box Yard.**
   ```sh
   sudo apt update && sudo apt install -y openssh-server git curl ca-certificates
   sudo adduser boxyard          # agents run as this user
   sudo -iu boxyard              # the rest runs as that user
   ```
2. **Node 18 or later** runs Box Yard's runner on the machine. Use any of these:
   ```sh
   # nvm (no sudo); Box Yard finds nvm's node through the login shell
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && . ~/.nvm/nvm.sh && nvm install --lts
   # or NodeSource, system-wide: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
   ```
3. **Claude Code.**
   ```sh
   curl -fsSL https://claude.ai/install.sh | bash       # installs to ~/.local/bin/claude
   # or: npm install -g @anthropic-ai/claude-code
   ```
4. **A Claude login.** Use one of these:
   - **Log in on the laptop.** Run `claude` once, then `/login` (it prints a URL you can open on another computer). Agents there use that login.
   - **Let Box Yard forward a Claude key for each turn.** Set it in Settings › Credentials › Claude or on the project's identity, as for boxes. Box Yard prefers it over the laptop's own login.
5. **Authorize Box Yard's SSH key.** Run this on the computer running Box Yard, not on the laptop:
   ```sh
   ssh-keygen -t ed25519 -f ~/.ssh/boxyard_laptops -C "box yard"     # a key just for your machines (optional)
   ssh-copy-id -i ~/.ssh/boxyard_laptops.pub boxyard@thinkpad.local
   ssh -i ~/.ssh/boxyard_laptops boxyard@thinkpad.local true          # once by hand: it must not ask for a password
   ```
   A key with a passphrase works through the SSH agent. Load it with `ssh-add ~/.ssh/boxyard_laptops`, then use `agent` or `agent:SHA256:…` (from `ssh-add -l`) as the key below.
6. **Keep it running.**
   ```sh
   sudo loginctl enable-linger boxyard   # the user's processes outlive the SSH session, so a turn survives a dropped connection
   ```
   - **Lid.** Keep the laptop awake with the lid closed: set `HandleLidSwitch=ignore` and `HandleLidSwitchExternalPower=ignore` in `/etc/systemd/logind.conf`, then run `sudo systemctl restart systemd-logind`.
   - **Sleep.** Or turn sleep off altogether: `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`.
   - **Address.** Give the laptop a fixed address on your network (a DHCP reservation), or use its `.local` name.
7. **Add it to Box Yard.** In **Settings › Machines › Add machine**, fill in:
   - name: `old-thinkpad`
   - host: `thinkpad.local`
   - user: `boxyard`
   - SSH key: `file:~/.ssh/boxyard_laptops`
   - Tasks running at once: 1 or 2, depending on its memory (about 2 GB per agent)
   - labels: `laptops`

   Box Yard tests the connection when you add it. The test reports the OS, CPUs, memory, free disk, git, node, claude and whether it's logged in, and codex. **Test connection** runs it again after you fix something.

   You can also ask the Coordinator, for example: *"add my laptop thinkpad.local, user boxyard, key file:~/.ssh/boxyard_laptops, label it laptops"*.
8. **Use it.** Any of these sends tasks to the laptop:
   - **A project:** project › Settings › Runs on › SSH machine, then "Which machines": `laptops`.
   - **One task:** ask the Coordinator to run it on the laptops (`runs_on: "label:laptops"`).
   - **"Run it locally":** in Settings › Machines, set **When you say "locally"** to `laptops`. From then on "run it locally" and "on my machine" (`runs_on: "local"`) mean the laptops, and `runs_on: "this_computer"` still means the computer running Box Yard.

### macOS machines

- **Remote Login.** Turn it on in System Settings › General › Sharing, for the user Box Yard logs in as.
- **Tools.** Install node and git with Homebrew (`brew install node git`) and Claude Code as above. Box Yard looks in `/opt/homebrew/bin`, `~/.local/bin` and the login shell's PATH.
- **Sleep.** While a turn runs, `caffeinate` keeps the Mac awake (as on the computer running Box Yard). To keep it reachable between turns, set System Settings › Energy › "Prevent automatic sleeping when the display is off", or run `sudo pmset -a sleep 0`.
- **Credentials.** macOS has no `/dev/shm`, so a turn's `task.json` is written to the task folder with mode 0600 and removed when the turn ends (see [Security](#security)).

## Labels and placement

- **Labels.** A machine's labels are free-form: lowercase letters, digits, dots, dashes and underscores (spaces become dashes), up to 20 per machine. A machine's name works as a label too, so `label:old-thinkpad` means that one machine.
- **Which machine a task gets.** The scheduler picks a machine that matches all of these:
  - it has the label;
  - it's turned on and passed its last test;
  - it answered the last time Box Yard reached it;
  - it has a Claude login to use (its own, or a key Box Yard forwards);
  - it has a free slot.

  A task returns to the machine its workspace is on while that machine qualifies. Otherwise it goes to the matching machine with the fewest agents running. A task moves to another machine only when nothing would be lost (its work is pushed and archived).
- **Limits.** Each machine's **Tasks running at once** (1–32) is its cap. A project's **Tasks running at once** (`agents_per_box`) and **Needs the whole machine** (`whole_machine`) apply on each machine as they do on boxes. Machines have their own queue, so they never take a box slot, and Max boxes and box costs don't count them.
- **Waiting.** A task waits, and says why, in these cases:
  - every matching machine is busy (a queue, no notice);
  - none of them works now (offline, off, or a failed test);
  - none of them has a Claude login.

  In the last two cases its Captain is told once. A label no machine has is refused at once, since it's a typo rather than a wait.
- **Offline machines.** A machine that doesn't answer (asleep, off the network) is skipped, and Box Yard tries it again every minute. A turn running there when it went away isn't failed: the runner runs detached on the machine, and Box Yard reads the turn's end once the machine answers again.
- **Where tasks run.** Each task works in `<work folder>/tasks/<task_id>` (the work folder is `~/boxyard` by default). Box Yard's runner, repo mirrors and dependency cache go in `<work folder>/.boxyard`. Keep the work folder out of any folder with a `CLAUDE.md`: Claude Code reads every `CLAUDE.md` above the folder it runs in.
- **Previews.** A preview is at `http://<host>:<port>`, since the agent's server listens on 0.0.0.0. The laptop's firewall has to let your browser reach it.
- **Archives.** As on boxes, the push at turn end (and the archive) keeps work safe. Removing a machine from Box Yard archives each task folder on it first, so its tasks pick up elsewhere.
- **Janitor.** The janitor cleans only Box Yard's work folder on a machine (stale task folders), never its `/tmp` or caches, which belong to the machine.
- **Box history.** Adding and removing a machine is in Boxes › History (`box_history`) under `SSH · <name>`, with who did it and why.

## Security

- **Keys by reference only.** You give Box Yard a key's name, never the key itself, and it never passes through the model. The forms are:
  - `file:~/.ssh/<key>`: a private key in this computer's `~/.ssh`. ssh reads it; Box Yard only checks its first line.
  - `agent`: any key in the SSH agent.
  - `agent:SHA256:…`: one key in the agent. Box Yard keeps its public half in `<data>/machines/<id>.pub` to tell ssh which key to use.
  - `default`: ssh's own defaults and `~/.ssh/config`.
- **Host keys.** Box Yard trusts a machine's host key the first time it connects, and keeps it in a known_hosts file of its own per machine (`<data>/machines/known_hosts-<id>`). A changed key stops every connection. The machine's card in Settings › Machines then offers **Forget host key…**: press it only if you reinstalled the machine or changed its SSH server.
- **ssh itself.** Box Yard runs the system `ssh` with:
  - a bare environment, so none of Box Yard's secrets can ride along;
  - `BatchMode=yes`, so it never prompts for a password;
  - nothing forwarded: no agent, no X11, no ports;
  - one shared connection per machine (`ControlPersist` 5 minutes).

  Every command goes to the machine on ssh's **stdin**, never in its arguments, because arguments show up in `ps` on both ends.
- **Credentials for one turn.** A turn's credentials reach the machine inside the turn's `task.json`, written over stdin. They are the GitHub token (`GITHUB_TOKEN`/`GH_TOKEN`), the Claude key when Box Yard has one, and the project's env.
  - **Linux.** `task.json` goes to the machine's memory (`/dev/shm/boxyard-<uid>`, mode 0700), linked from the task folder.
  - **macOS.** It goes to the task folder, mode 0600.
  - **After the turn.** The runner removes `task.json` as the turn ends, so the machine keeps no Box Yard credential between turns. An identity's commit signing key works the same way.
  - **Not logged.** Credentials are never written to Box Yard's logs.
- **Nothing installed.** Box Yard never uses `sudo`, never installs anything and never changes the machine's git or shell config. Removing a machine from Box Yard leaves its work folder in place.

## Settings › Machines and the Boxes page

- **Settings › Machines** lists each machine with:
  - its state: Ready, Busy, Offline, Needs setup, Off or Not tested;
  - its tasks running and its Tasks running at once;
  - its address, key reference, work folder and labels;
  - the last test's results.

  Each machine has **Test connection**, **Edit…** and **Remove…**, and **Add machine** adds one. **When you say "locally"** picks what `runs_on: "local"` means.
- **The Boxes page** shows the same machines, each with the tasks on it.

## MCP tools

- **Every caller, Captains included:**
  - `list_machines {machine?}`: each machine's state, labels, running count, last test and what `runs_on: "local"` means.
- **Coordinator only:**
  - `add_machine {name, host, user, ssh_key, port?, max_tasks?, labels?, dir?, test?}`: adds a machine and tests it (`test: false` skips the test). `ssh_key` is a reference as above.
  - `update_machine {machine, name?, host?, user?, port?, ssh_key?, max_tasks?, labels?, add_labels?, remove_labels?, dir?, enabled?}`: a new address, user, port, key or work folder tests the machine again. `enabled: false` turns it off for new turns.
  - `test_machine {machine}`: tests the connection now.
  - `remove_machine {machine}`: refused while an agent runs there. Each task folder is archived first.
- **Placing tasks.** `create_task`, `create_tasks` and `send_to_task` take:
  - `runs_on`:
    - `"ssh"`: any SSH machine, or the ones `machine_label` names;
    - `"label:<label>"` (or `"ssh:<label>"`): a free machine with that label;
    - `"local"`: this computer, or the label set in Settings › Machines;
    - `"this_computer"`: always the computer running Box Yard;
    - `"box"`, `"gpu"` or `"docker"`.
  - `machine_label`: used with `runs_on: "ssh"`, or alone.
- **Projects.** `update_project {machine_label}` changes which machines a project already on SSH machines uses. Moving a project onto SSH machines is Cody's choice, in its Settings. `pool_status` lists the machines under `ssh_machines`.

`machine` takes a machine's id or name. A machine is in `machine_label` and `runs_on` by its labels or its name.

## REST

| Method and path | What it does |
| --- | --- |
| `GET /api/machines` | Every machine with its state, the labels, and the settings |
| `POST /api/machines` | Add a machine `{name, host, user, port, keyRef, maxTasks, labels, dir, enabled, test}` |
| `PATCH /api/machines/:id` | Change it |
| `DELETE /api/machines/:id[?force=1]` | Remove it. `force` removes it even when an offline machine's task folders can't be archived |
| `POST /api/machines/:id/test` | Test the connection |
| `POST /api/machines/:id/forget-host-key` | Forget its host key, then test it |
| `PUT /api/machines/settings` | `{localLabel}`: what "locally" means |

## Codex

The connection test detects Codex (`codex --version`) and shows it, but Box Yard runs Claude Code only. A Codex engine would need:

- **Output.** A runner path that starts `codex exec --json` and maps its JSONL events (messages, tool calls, usage) onto Box Yard's event log.
- **The MCP bridge.** Box Yard's MCP server registered in Codex's config (`[mcp_servers.boxyard]` in a per-task `CODEX_HOME/config.toml`) so the agent can ask, publish and mark done.
- **Resume.** Turns resume through Codex's session id (`codex exec resume <id>`), and compaction and recaps are mapped to it.
- **Login.** An `OPENAI_API_KEY` forwarded per turn like the Claude key, or the machine's own `codex login` (`~/.codex/auth.json`).
- **Permissions.** Its non-interactive flags (`--ask-for-approval never`, `--sandbox workspace-write` or `danger-full-access`) as the counterpart of Claude Code's permission mode.
- **Usage and models.** Token usage and pricing, and model and effort choices per task.
