import os from "node:os"

/**
 * Where the server listens. With no BOXYARD_PASSWORD there's no login, so it stays on this computer (127.0.0.1)
 * unless HOST says otherwise. With a password it listens everywhere (0.0.0.0), so a phone or Tailscale just works.
 */
export function defaultHost(env: { HOST?: string; BOXYARD_PASSWORD?: string }) {
  return env.HOST?.trim() || (env.BOXYARD_PASSWORD ? "0.0.0.0" : "127.0.0.1")
}

/** `localhost`, 127.0.0.0/8 or ::1: only this computer can connect. */
export function isLoopback(host: string) {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "")
  return h === "localhost" || h === "::1" || /^(::ffff:)?127\.\d+\.\d+\.\d+$/.test(h)
}

/** 0.0.0.0 or ::: every interface. */
export function isWildcard(host: string) {
  const h = host.trim().replace(/^\[|\]$/g, "")
  return h === "" || h === "0.0.0.0" || h === "::" || h === "::0"
}

/** Why the server must not start: a host other devices can reach, no password, and no BOXYARD_ALLOW_OPEN=1. */
export function bindProblem(c: { host: string; port: number; password: string; allowOpen: boolean }): string | null {
  if (c.password || c.allowOpen || isLoopback(c.host)) return null
  return [
    `HOST=${c.host} lets other devices reach Box Yard, but BOXYARD_PASSWORD isn't set, so anyone on your network could control it.`,
    `Set BOXYARD_PASSWORD in .env (it turns on the login), or remove HOST to keep Box Yard on this computer (http://localhost:${c.port}).`,
    `To run it open anyway (e.g. behind your own auth proxy), set BOXYARD_ALLOW_OPEN=1.`,
  ].join("\n")
}

/** The URL for reaching our own server from this computer (the MCP endpoint for local Claude sessions). */
export function selfUrl(host: string, port: number) {
  if (isWildcard(host) || host.trim().toLowerCase() === "localhost") return `http://127.0.0.1:${port}`
  return `http://${urlHost(host)}:${port}`
}

const urlHost = (host: string) => (host.includes(":") && !host.startsWith("[") ? `[${host}]` : host)

/** 100.64.0.0/10, the range Tailscale hands out. */
export function isTailscale(ip: string) {
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(ip)
  return Boolean(m && Number(m[1]) >= 64 && Number(m[1]) <= 127)
}

export type ListenUrl = { label: "Local" | "LAN" | "Tailscale" | "Network"; url: string }

/**
 * The URLs to open Box Yard on, for the startup log. A wildcard bind lists this computer plus every IPv4 address
 * from the network interfaces (100.64.0.0/10 is Tailscale); a specific host is just itself.
 */
export function listenUrls(host: string, port: number, interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): ListenUrl[] {
  if (isLoopback(host)) return [{ label: "Local", url: `http://localhost:${port}` }]
  if (!isWildcard(host)) {
    const ip = host.replace(/^\[|\]$/g, "")
    return [{ label: isTailscale(ip) ? "Tailscale" : "Network", url: `http://${urlHost(host)}:${port}` }]
  }
  const urls: ListenUrl[] = [{ label: "Local", url: `http://localhost:${port}` }]
  const seen = new Set<string>()
  for (const infos of Object.values(interfaces)) {
    for (const i of infos ?? []) {
      if (i.internal || i.family !== "IPv4" || seen.has(i.address)) continue
      seen.add(i.address)
      urls.push({ label: isTailscale(i.address) ? "Tailscale" : "LAN", url: `http://${i.address}:${port}` })
    }
  }
  return urls
}
