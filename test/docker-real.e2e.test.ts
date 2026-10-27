import { afterAll, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { docker } from "../server/docker/cli.js"
import { DOCKER_SECRETS_DIR } from "../server/providers/docker.js"
import { GITHUB_HELPER, setHelperScript } from "../server/gitShare.js"
import { dockerBoxId } from "../shared/docker.js"
import type { Identity } from "../shared/identities.js"
import type { Project, Task } from "../shared/types.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// The Docker runner on this computer's real Docker, end to end. Opt-in: it builds Box Yard's image the first time
// (a few minutes, about 2 GB), then runs a whole task in a real container and deletes the container and its volume.
//
//   npm run test:docker          (BOXYARD_DOCKER_E2E=1 vitest run test/docker-real.e2e.test.ts)
//
// The agent is scripts/fake-claude.mjs, copied into the container, so no Claude key is needed: it starts a server
// on $PORT and reports it as a preview. Box Yard's own image (and only it) stays, so the next run is fast.

const enabled = process.env.BOXYARD_DOCKER_E2E === "1"
const FAKE_IN_CONTAINER = "/workspace/.boxyard/fake-claude.mjs"
const GH_SECRET = `ghp_${"E2E".repeat(12)}`

let yard: BoxYard | null = null
let server: Server | null = null
let box: string | null = null

afterAll(async () => {
  if (!yard) return
  const y = yard
  for (const t of y.store.listTaskRows()) if (t.current_turn_id) await y.tasks.stopTask(t.id).catch(() => {})
  await waitFor(() => y.store.listTaskRows().every((t) => !t.current_turn_id && t.status !== "working"), "turns to end", 60_000).catch(() => {})
  if (box) await yard.docker.provider.destroy(box).catch((err) => console.warn(`couldn't delete ${box}: ${(err as Error).message}`))
  yard.stop()
  await new Promise((res) => server?.close(() => res(null)))
}, 120_000)

describe.skipIf(!enabled)("Docker runner on real Docker (BOXYARD_DOCKER_E2E=1)", () => {
  it(
    "runs a task in its project's container, previews on localhost, keeps secrets off the image and command lines, and deletes it all",
    async () => {
      const port = await freePort()
      const config = testConfig({ port })
      const y = (yard = createBoxYard(config, { webDir: "/nonexistent", realDocker: { claudeBin: `node ${FAKE_IN_CONTAINER}` } }))
      y.docker.onEvent = (e) => y.tasks.dockerEvent(e)
      y.docker.onProgress = (b, m) => y.tasks.startProgress(b, m)
      server = await new Promise<Server>((resolve) => {
        const s = y.app.listen(port, "127.0.0.1", () => resolve(s))
      })
      await y.start()
      const base = `http://127.0.0.1:${port}`
      const call = async <T>(method: string, url: string, body?: unknown): Promise<T> => {
        const res = await fetch(base + url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
        const data = await res.json()
        if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(data)}`)
        return data as T
      }

      const info = await y.docker.engine.info(true)
      expect(info.error, "Docker must be running for this test").toBeNull()
      const bin = info.bin!
      const sh = async (command: string) => {
        const r = await y.docker.provider.exec(box!, command)
        if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${(r.stderr || r.stdout).slice(-600)}`)
        return r.stdout.trim()
      }

      const p = await call<Project>("POST", "/api/projects", { name: "docker-e2e", runner: "docker", env: { GITHUB_TOKEN: GH_SECRET } })
      expect(y.store.projectEnv(p.id).GITHUB_TOKEN).toBe(GH_SECRET)
      box = dockerBoxId(p.id)

      // The container, from Box Yard's image (built now if this computer doesn't have it yet).
      const started = Date.now()
      await y.docker.provider.wake(box)
      console.log(`container up in ${Math.round((Date.now() - started) / 1000)}s from ${await y.docker.images.ensure(p.id)}`)
      expect(await sh("node --version && git --version && gh --version | head -1 && claude --version && chromium --version")).toMatch(/v24[\s\S]*git version[\s\S]*gh version[\s\S]*Claude Code[\s\S]*Chromium/)
      await y.docker.provider.writeFile(box, FAKE_IN_CONTAINER, fs.readFileSync(path.resolve("scripts/fake-claude.mjs")))

      // A task: its turn runs in the container, serves on $PORT and reports it, and ends.
      const t = y.tasks.createTask({ projectId: p.id, title: "serve a page", prompt: "show me [preview]" })
      const turned = await waitFor(
        () => {
          const x = y.store.getTask(t.id)!
          if (x.status === "failed") return x
          return x.turnCount >= 1 && !x.currentTurnId && x.previews.length && !["starting", "queued", "working"].includes(x.status) ? x : null
        },
        "the task's turn to report a preview and end",
        180_000,
      ).catch((err: Error) => {
        const x = y.store.getTask(t.id)!
        throw new Error(`${err.message}: ${JSON.stringify({ status: x.status, error: x.error, waitReason: x.waitReason, events: y.store.listTaskMessages(t.id, 50).filter((m) => m.role === "event").map((m) => m.content).slice(-8) })}`)
      })
      expect(turned.boxId).toBe(box)
      expect(turned.error).toBeNull()
      const task = await call<Task>("GET", `/api/tasks/${t.id}`)
      const preview = task.previews[0]
      if (!preview) {
        const log = await sh(`tail -n 40 ${y.tasks.taskDir(box, t.id)}/runner.log; ls -la ${y.tasks.taskDir(box, t.id)}`).catch((err: Error) => err.message)
        const events = y.store.listTaskMessages(t.id, 80).map((m) => `${m.role}: ${m.content.slice(0, 300)}`)
        throw new Error(`no preview: ${JSON.stringify({ status: task.status, error: task.error, events, log }, null, 1)}`)
      }
      expect(preview?.url).toMatch(/^http:\/\/localhost:\d+/)
      const page = await waitFor(async () => {
        const res = await fetch(preview!.url.replace("localhost", "127.0.0.1")).catch(() => null)
        return res?.ok ? res.text() : null
      }, "the preview to answer on this computer")
      expect(page).toContain("Box Yard preview")

      // Only its own volume is mounted; no Docker socket; previews on 127.0.0.1 only.
      const name = (await y.docker.provider.list(true)).find((x) => x.boxId === box)!.name
      const inspect = (await docker(bin, ["container", "inspect", name])).stdout.toString("utf8")
      const [c] = JSON.parse(inspect) as { Mounts: { Type: string; Destination: string }[]; HostConfig: { PortBindings: Record<string, { HostIp: string }[]>; Privileged: boolean }; Config: { Image: string } }[]
      expect(c!.Mounts.map((m) => [m.Type, m.Destination])).toEqual([["volume", "/workspace"]])
      expect(c!.HostConfig.Privileged).toBe(false)
      for (const bindings of Object.values(c!.HostConfig.PortBindings)) for (const b of bindings) expect(b.HostIp).toBe("127.0.0.1")
      expect(await sh("test -e /var/run/docker.sock && echo yes || echo no")).toBe("no")

      // The turn's credentials: in task.json on the tmpfs only, never in the container's config, env or the image.
      expect(await sh(`readlink ${y.tasks.taskDir(box, t.id)}/task.json`)).toBe(`${DOCKER_SECRETS_DIR}/${t.id}.json`)
      expect(await sh(`grep -c ${GH_SECRET} ${DOCKER_SECRETS_DIR}/${t.id}.json`)).toBe("1")
      expect(await sh(`awk '$2 == "${DOCKER_SECRETS_DIR}" { print $3 }' /proc/mounts`)).toBe("tmpfs")
      expect(inspect).not.toContain(GH_SECRET)
      const history = (await docker(bin, ["image", "history", "--no-trunc", c!.Config.Image])).stdout.toString("utf8")
      expect(history).not.toContain(GH_SECRET)

      // F1: a credential store in the container's own git config can't answer before the turn's GITHUB_TOKEN.
      const fill = `printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p'`
      expect(
        await sh(
          `cd /tmp && rm -rf f1 && git init -q f1 && cd f1 && printf 'https://x:stored-token@github.com\\n' > ~/.git-credentials && git config --global credential.helper store && ${setHelperScript(GITHUB_HELPER, true)} && export GITHUB_TOKEN=turn-token && ${fill}; git config --global --unset credential.helper; rm -f ~/.git-credentials`,
        ),
      ).toBe("turn-token")

      // Stop keeps the workspace on the volume; a command starts it again.
      await call("POST", `/api/docker/containers/${box}/stop`)
      expect((await y.docker.provider.list(true)).find((x) => x.boxId === box)!.state).toBe("exited")
      expect(await sh(`test -f ${y.tasks.taskDir(box, t.id)}/work/box-yard-demo.md && echo kept`)).toBe("kept")
      // The tmpfs went with the stop: the credentials aren't on the volume.
      expect(await sh(`test -e ${DOCKER_SECRETS_DIR}/${t.id}.json && echo there || echo gone`)).toBe("gone")

      // Delete: the container and its volume go (its workspace is archived first).
      await call("DELETE", `/api/boxes/${box}`)
      const volume = `${name}-work`
      expect((await docker(bin, ["container", "inspect", name])).code).not.toBe(0)
      expect((await docker(bin, ["volume", "inspect", volume])).code).not.toBe(0)
      expect(y.tasks.history.list({ boxId: box }).map((e) => e.type).reverse()).toEqual(["created", "stopped", "started", "deleted"])
      box = null
    },
    40 * 60_000,
  )

  it(
    "signs a turn's commits in the container with its identity's key, kept on the tmpfs only, and removes it with the turn",
    async () => {
      const port = await freePort()
      const LOG = "/workspace/.boxyard/sign.log"
      // The agent: commits in its work folder, writes where its signing key is, then runs the fake claude.
      const WRAP = "/workspace/.boxyard/claude-sign.sh"
      const wrapper = `#!/bin/sh
prompt=$(cat)
id=$(basename "$(dirname "$PWD")")
git rev-parse --git-dir >/dev/null 2>&1 || git init -q
echo x >> signed.txt && git add signed.txt && git commit -qm "signed in docker" >> ${LOG} 2>&1 || echo COMMIT_FAILED >> ${LOG}
k=$(git config user.signingKey)
echo "SIGNING_KEY=$k" >> ${LOG}
echo "KEY_MODE=$(stat -c %a "$k")" >> ${LOG}
echo "KEY_FS=$(stat -f -c %T "$k")" >> ${LOG}
echo "DELIVERED=$(test -e ../signing.key && echo there || echo gone)" >> ${LOG}
echo "ON_DISK=$(test -e "\${TMPDIR:-/tmp}/boxyard-sign-$id/key" && echo there || echo none)" >> ${LOG}
git log -1 --format='SIG %s %G?' >> ${LOG}
printf '%s' "$prompt" | exec node ${FAKE_IN_CONTAINER} "$@"
`
      const config = testConfig({ port })
      const y = createBoxYard(config, { webDir: "/nonexistent", realDocker: { claudeBin: `sh ${WRAP}` } })
      y.docker.onEvent = (e) => y.tasks.dockerEvent(e)
      const listening = await new Promise<Server>((resolve) => {
        const s = y.app.listen(port, "127.0.0.1", () => resolve(s))
      })
      await y.start()
      let signBox: string | null = null
      try {
        const keyFile = path.join(tmpDir("docker-signing-"), "key")
        execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "docker-e2e", "-f", keyFile])
        const acme = y.identities.create({ name: "Acme", author: { name: "Acme Bot", email: "bot@acme.example" } })
        await y.identities.saveSigning(acme.id, { kind: "file", privateKey: fs.readFileSync(keyFile, "utf8") })
        const p = y.store.createProject({ name: "docker-signing-e2e", runner: "docker", identityId: acme.id })
        signBox = dockerBoxId(p.id)
        const sh = async (command: string) => {
          const r = await y.docker.provider.exec(signBox!, command)
          if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${(r.stderr || r.stdout).slice(-600)}`)
          return r.stdout.trim()
        }
        await y.docker.provider.wake(signBox)
        await y.docker.provider.writeFile(signBox, FAKE_IN_CONTAINER, fs.readFileSync(path.resolve("scripts/fake-claude.mjs")))
        await y.docker.provider.writeFile(signBox, WRAP, wrapper)

        const t = y.tasks.createTask({ projectId: p.id, title: "sign a commit", prompt: "commit something" })
        await waitFor(() => {
          const x = y.store.getTask(t.id)!
          return x.status === "failed" || (x.turnCount >= 1 && !x.currentTurnId && !["starting", "queued", "working"].includes(x.status)) ? x : null
        }, "the task's turn to end", 180_000)
        const lines = (await sh(`cat ${LOG}`)).split("\n")
        expect(lines).not.toContain("COMMIT_FAILED")
        expect(lines).toContain("SIG signed in docker G")
        expect(lines).toContain(`SIGNING_KEY=${DOCKER_SECRETS_DIR}/sign-${t.id}.key`)
        expect(lines).toContain("KEY_MODE=600")
        expect(lines).toContain("KEY_FS=tmpfs")
        expect(lines).toContain("DELIVERED=gone")
        expect(lines).toContain("ON_DISK=none")
        // After the turn: neither copy is on the tmpfs, and nothing on the volume holds the key.
        expect(await sh(`ls -A ${DOCKER_SECRETS_DIR}`)).toBe(`${t.id}.json`)
        const pem = fs.readFileSync(keyFile, "utf8").split("\n")[1]!
        expect(await sh(`grep -rlF -- ${JSON.stringify(pem)} /workspace /tmp 2>/dev/null || echo none`)).toBe("none")
      } finally {
        if (signBox) await y.docker.provider.destroy(signBox).catch((err) => console.warn(`couldn't delete ${signBox}: ${(err as Error).message}`))
        y.stop()
        await new Promise((res) => listening.close(() => res(null)))
      }
    },
    40 * 60_000,
  )
})
