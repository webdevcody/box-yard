import { describe, expect, it } from "vitest"
import type os from "node:os"
import { bindProblem, defaultHost, isLoopback, isTailscale, listenUrls, selfUrl } from "../server/bind.js"

/** The host the server would listen on and whether it refuses to start, from env as the user sets it. */
function decide(env: { HOST?: string; BOXYARD_PASSWORD?: string; BOXYARD_ALLOW_OPEN?: string }) {
  const host = defaultHost(env)
  const refused = bindProblem({ host, port: 3000, password: env.BOXYARD_PASSWORD ?? "", allowOpen: env.BOXYARD_ALLOW_OPEN === "1" })
  return { host, refused }
}

describe("bind decision", () => {
  it("stays on 127.0.0.1 with no password and no HOST", () => {
    expect(decide({})).toEqual({ host: "127.0.0.1", refused: null })
    expect(decide({ HOST: "  ", BOXYARD_PASSWORD: "" })).toEqual({ host: "127.0.0.1", refused: null })
  })

  it("uses a loopback HOST as given, password or not", () => {
    for (const HOST of ["127.0.0.1", "localhost", "::1", "127.0.0.2"]) {
      expect(decide({ HOST })).toEqual({ host: HOST, refused: null })
      expect(decide({ HOST, BOXYARD_PASSWORD: "pw" })).toEqual({ host: HOST, refused: null })
    }
  })

  it("listens on 0.0.0.0 by default once a password is set", () => {
    expect(decide({ BOXYARD_PASSWORD: "pw" })).toEqual({ host: "0.0.0.0", refused: null })
  })

  it("starts on a wide HOST when a password is set", () => {
    for (const HOST of ["0.0.0.0", "::", "192.168.1.20", "100.101.102.103"]) {
      expect(decide({ HOST, BOXYARD_PASSWORD: "pw" })).toEqual({ host: HOST, refused: null })
    }
  })

  it("refuses a wide HOST with no password, and says how to fix it", () => {
    for (const HOST of ["0.0.0.0", "::", "192.168.1.20", "100.101.102.103"]) {
      const { refused } = decide({ HOST })
      expect(refused).toContain(`HOST=${HOST}`)
      expect(refused).toContain("BOXYARD_PASSWORD")
      expect(refused).toContain("BOXYARD_ALLOW_OPEN=1")
    }
  })

  it("starts open on a wide HOST with BOXYARD_ALLOW_OPEN=1 (and only with 1)", () => {
    expect(decide({ HOST: "0.0.0.0", BOXYARD_ALLOW_OPEN: "1" })).toEqual({ host: "0.0.0.0", refused: null })
    expect(decide({ HOST: "0.0.0.0", BOXYARD_ALLOW_OPEN: "true" }).refused).toBeTruthy()
    // The opt-out never widens the default: no HOST still means this computer only.
    expect(decide({ BOXYARD_ALLOW_OPEN: "1" })).toEqual({ host: "127.0.0.1", refused: null })
  })
})

describe("addresses", () => {
  it("knows loopback and Tailscale ranges", () => {
    expect(["localhost", "127.0.0.1", "::1", "[::1]", "::ffff:127.0.0.1"].every(isLoopback)).toBe(true)
    expect(["0.0.0.0", "::", "192.168.1.2", "128.0.0.1"].some(isLoopback)).toBe(false)
    expect(["100.64.0.1", "100.100.1.1", "100.127.255.254"].every(isTailscale)).toBe(true)
    expect(["100.63.255.255", "100.128.0.1", "10.0.0.1"].some(isTailscale)).toBe(false)
  })

  it("points local Claude sessions at the address the server listens on", () => {
    expect(selfUrl("127.0.0.1", 3000)).toBe("http://127.0.0.1:3000")
    expect(selfUrl("localhost", 3000)).toBe("http://127.0.0.1:3000")
    expect(selfUrl("0.0.0.0", 3000)).toBe("http://127.0.0.1:3000")
    expect(selfUrl("::", 3000)).toBe("http://127.0.0.1:3000")
    expect(selfUrl("100.101.102.103", 3000)).toBe("http://100.101.102.103:3000")
    expect(selfUrl("::1", 3000)).toBe("http://[::1]:3000")
  })
})

describe("startup URLs", () => {
  const nic = (address: string, family: "IPv4" | "IPv6" = "IPv4", internal = false) =>
    ({ address, family, internal, netmask: "", mac: "", cidr: null }) as os.NetworkInterfaceInfo
  const interfaces = {
    lo: [nic("127.0.0.1", "IPv4", true), nic("::1", "IPv6", true)],
    en0: [nic("192.168.1.20"), nic("fe80::1", "IPv6")],
    tailscale0: [nic("100.101.102.103"), nic("fd7a:115c:a1e0::1", "IPv6")],
  }

  it("lists only localhost when bound to loopback", () => {
    expect(listenUrls("127.0.0.1", 3000, interfaces)).toEqual([{ label: "Local", url: "http://localhost:3000" }])
  })

  it("lists localhost, LAN and Tailscale URLs when bound wide", () => {
    expect(listenUrls("0.0.0.0", 3000, interfaces)).toEqual([
      { label: "Local", url: "http://localhost:3000" },
      { label: "LAN", url: "http://192.168.1.20:3000" },
      { label: "Tailscale", url: "http://100.101.102.103:3000" },
    ])
  })

  it("lists just the host when bound to one address", () => {
    expect(listenUrls("100.101.102.103", 4000, interfaces)).toEqual([{ label: "Tailscale", url: "http://100.101.102.103:4000" }])
    expect(listenUrls("192.168.1.20", 4000, interfaces)).toEqual([{ label: "Network", url: "http://192.168.1.20:4000" }])
  })
})
