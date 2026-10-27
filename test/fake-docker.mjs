#!/usr/bin/env node
// A stand-in for the `docker` CLI, for the Docker runner's unit tests (test/docker-provider.test.ts). It keeps
// containers, volumes and images in a JSON file ($FAKE_DOCKER_STATE) and logs every call, argv and stdin, to
// $FAKE_DOCKER_LOG (one JSON line each), so a test can check what Box Yard asked Docker and that no secret was on a
// command line. Only what Box Yard runs is understood. `exec` runs nothing: it answers `id -u; id -g`, `cat` of a
// file a test put in state.files, and otherwise exits 0.
import fs from "node:fs"

const stateFile = process.env.FAKE_DOCKER_STATE
const logFile = process.env.FAKE_DOCKER_LOG
const args = process.argv.slice(2)
const empty = { daemon: true, containers: {}, volumes: {}, images: [], files: {}, failRun: null }
const state = { ...empty, ...(stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {}) }
const save = () => stateFile && fs.writeFileSync(stateFile, JSON.stringify(state, null, 1))

const stdin = process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8")
if (logFile) fs.appendFileSync(logFile, JSON.stringify({ args, stdin }) + "\n")

const out = (s) => process.stdout.write(s)
const fail = (msg, code = 1) => {
  process.stderr.write(msg + "\n")
  process.exit(code)
}
/** --flag value pairs (repeatable), and what's left. */
function parse(list, withValue) {
  const flags = {}
  const rest = []
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    if (withValue.includes(a)) {
      ;(flags[a] ??= []).push(list[++i])
    } else rest.push(a)
  }
  return { flags, rest }
}
const labelsOf = (pairs = []) => Object.fromEntries(pairs.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]))
const labelString = (labels) => Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(",")
const matches = (labels, filters = []) =>
  filters.every((f) => {
    if (!f.startsWith("label=")) return true
    const [k, v] = f.slice(6).split(/=(.*)/s)
    return v === undefined ? k in labels : labels[k] === v
  })

if (args[0] === "--version") {
  out("Docker version 27.3.1, build fake\n")
  process.exit(0)
}
if (!state.daemon) fail("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?")

const [cmd, ...rest] = args
switch (cmd) {
  case "info":
    out(JSON.stringify({ ServerVersion: "27.3.1", NCPU: 8, MemTotal: 8 * 1024 ** 3 }) + "\n")
    break
  case "container": {
    if (rest[0] !== "inspect") fail(`fake docker: container ${rest[0]}`)
    const c = state.containers[rest[1]]
    if (!c) fail(`Error: No such container: ${rest[1]}`)
    out(JSON.stringify([{ Id: c.id, State: { Status: c.running ? "running" : "exited", Running: c.running, StartedAt: c.startedAt }, Config: { Labels: c.labels, Image: c.image } }]))
    break
  }
  case "volume": {
    const [sub, ...more] = rest
    const { flags, rest: names } = parse(more, ["--format", "--label", "--filter"])
    if (sub === "inspect") {
      const v = state.volumes[names[0]]
      if (!v) fail(`Error response from daemon: get ${names[0]}: no such volume`)
      const format = flags["--format"]?.[0] ?? ""
      const index = format.match(/index \.Labels "([^"]+)"/)
      out(index ? `${v.labels[index[1]] ?? ""}\n` : `${JSON.stringify(v.labels)}\n`)
    } else if (sub === "create") {
      state.volumes[names[0]] = { labels: labelsOf(flags["--label"]) }
      save()
      out(names[0] + "\n")
    } else if (sub === "rm") {
      delete state.volumes[names.filter((n) => n !== "-f")[0]]
      save()
    } else if (sub === "ls") {
      for (const v of Object.values(state.volumes)) if (matches(v.labels, flags["--filter"])) out(labelString(v.labels) + "\n")
    } else fail(`fake docker: volume ${sub}`)
    break
  }
  case "ps": {
    const { flags } = parse(rest, ["--filter", "--format"])
    const format = flags["--format"]?.[0] ?? ""
    for (const [name, c] of Object.entries(state.containers)) {
      if (!matches(c.labels, flags["--filter"])) continue
      const label = format.match(/\.Label "([^"]+)"/)
      if (label) out(`${c.labels[label[1]] ?? ""}\n`)
      else out(JSON.stringify({ ID: c.id.slice(0, 12), Names: name, Image: c.image, State: c.running ? "running" : "exited", Labels: labelString(c.labels) }) + "\n")
    }
    break
  }
  case "inspect": {
    const ids = rest.filter((a, i) => a !== "--format" && rest[i - 1] !== "--format")
    for (const c of Object.values(state.containers)) if (ids.includes(c.id.slice(0, 12))) out(`${c.id} ${c.startedAt}\n`)
    break
  }
  case "run": {
    const { flags, rest: positional } = parse(rest, ["--name", "--label", "--cpus", "--memory", "--memory-swap", "--pids-limit", "--shm-size", "--mount", "--tmpfs", "-e", "-p", "--entrypoint"])
    const name = flags["--name"][0]
    if (state.failRun) {
      const msg = state.failRun
      state.failRun = null
      save()
      fail(msg, 125)
    }
    if (state.containers[name]) fail(`docker: Error response from daemon: Conflict. The container name "/${name}" is already in use.`, 125)
    const image = positional.filter((a) => !a.startsWith("-"))[0]
    state.containers[name] = { id: `${Math.random().toString(16).slice(2).padEnd(12, "0")}${"0".repeat(52)}`, image, labels: labelsOf(flags["--label"]), running: true, startedAt: new Date().toISOString(), ports: flags["-p"] ?? [] }
    save()
    out(state.containers[name].id + "\n")
    break
  }
  case "start":
  case "stop":
  case "rm":
  case "update": {
    const name = rest.at(-1)
    const c = state.containers[name]
    if (!c) fail(`Error response from daemon: No such container: ${name}`)
    if (cmd === "start") Object.assign(c, { running: true, startedAt: new Date().toISOString() })
    if (cmd === "stop") c.running = false
    if (cmd === "rm") delete state.containers[name]
    save()
    out(name + "\n")
    break
  }
  case "exec": {
    let i = 0
    while (rest[i]?.startsWith("-")) i += rest[i] === "-u" ? 2 : 1
    const name = rest[i]
    const command = rest.slice(i + 1)
    const c = state.containers[name]
    if (!c) fail(`Error response from daemon: No such container: ${name}`)
    if (!c.running) fail(`Error response from daemon: container ${c.id} is not running`)
    if (command.join(" ").includes("id -u; id -g")) out("1000\n1000\n")
    else if (command[0] === "cat") {
      const file = command.at(-1)
      if (!(file in state.files)) fail(`cat: ${file}: No such file or directory`)
      out(state.files[file])
    }
    break
  }
  case "image": {
    const [sub, ...more] = rest
    if (sub === "inspect") {
      if (!state.images.includes(more.at(-1))) fail(`Error response from daemon: No such image: ${more.at(-1)}`)
      out("sha256:fake\n")
    } else if (sub === "ls") {
      for (const i of state.images) out(i + "\n")
    } else if (sub === "rm") {
      state.images = state.images.filter((i) => i !== more.at(-1))
      save()
    } else fail(`fake docker: image ${sub}`)
    break
  }
  case "build": {
    const { flags, rest: positional } = parse(rest, ["--progress", "--label", "-t", "--build-arg"])
    const dir = positional.at(-1)
    const dockerfile = fs.readFileSync(`${dir}/Dockerfile`, "utf8")
    if (logFile) fs.appendFileSync(logFile, JSON.stringify({ build: { dir, dockerfile, files: fs.readdirSync(dir), buildArgs: flags["--build-arg"] ?? [] } }) + "\n")
    process.stderr.write("#1 [internal] load build definition from Dockerfile\n#2 DONE 0.1s\n")
    state.images.push(flags["-t"][0])
    save()
    break
  }
  case "pull":
    state.images.push(rest[0])
    save()
    break
  default:
    fail(`fake docker: ${cmd}`)
}
