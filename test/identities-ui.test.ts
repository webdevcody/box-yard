// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SettingsDialog } from "../web/src/components/SettingsDialog.js"
import { keys } from "../web/src/lib/queries.js"
import { editCount, parseOwners } from "../web/src/components/Identities.js"
import { currentConfirm, settleConfirm } from "../web/src/lib/confirm.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { DEFAULT_IDENTITY_ID, type Identity, type IdentityDetection } from "../shared/identities"
import type { Project, Settings, SettingsInfo } from "../shared/types"

// Settings › Identities follows Settings' rule: nothing saves on change. Edits, a pasted token, Add, Delete and the
// imports a detection proposes are drafts the dialog's Save writes; Detect and Test only read. A pasted token goes
// out once, on Save, and never shows again.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PASTED = "ghp_pastedTokenValue000000000000000000"

const identity = (id: string, name: string, extra: Partial<Identity> = {}): Identity => ({
  id,
  name,
  color: "sky",
  isDefault: id === DEFAULT_IDENTITY_ID,
  githubLogin: null,
  githubId: null,
  owners: [],
  tokens: [],
  author: null,
  signing: null,
  claude: null,
  runners: null,
  coordinatorSees: "everything",
  projectIds: [],
  lastCheck: null,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
})
const acme = () =>
  identity("idn_acme", "Acme", {
    githubLogin: "octo-acme",
    owners: ["acme-corp"],
    projectIds: ["prj_app"],
    tokens: [{ owner: "", fingerprint: "100da730fa2f", login: "octo-acme", scopes: ["repo"], expiresAt: null, source: "gh:github.com:octo-acme", readable: true, savedAt: 1 }],
    author: { name: "Acme Octo", email: "octo@acme.dev", emailCheck: "verified" },
  })
const project = (id: string, name: string, identityId = DEFAULT_IDENTITY_ID) => ({ id, name, repo: `acme-corp/${name}`, identityId }) as unknown as Project

const detection: IdentityDetection = {
  at: Date.now(),
  online: true,
  accounts: [],
  authors: [],
  sshHosts: [],
  credentialHelpers: [],
  proposals: [
    {
      name: "octocat",
      login: "octocat",
      host: "github.com",
      tokenRef: "gh:github.com:octocat",
      owners: ["octocat"],
      author: { name: "Octo Cat", email: "octocat@example.com", from: "~/.gitconfig" },
      signing: null,
      projects: [
        { id: "prj_site", name: "site", repo: "octocat/site", why: "octocat owns it and can push", currentIdentity: "Default" },
        { id: "prj_blog", name: "blog", repo: "octocat/blog", why: "octocat owns it and can push", currentIdentity: "Default" },
      ],
      isDefaultToday: false,
      existing: null,
      evidence: ["gh is signed in to octocat (its active account)"],
    },
  ],
  unmatched: [],
  notes: [],
}

const settingsInfo = (values: Partial<Settings> = {}): SettingsInfo => ({
  settings: { ...DEFAULT_SETTINGS, ...values },
  sources: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, "default"])) as SettingsInfo["sources"],
  defaults: DEFAULT_SETTINGS,
})

let root: Root
let host: HTMLElement
let qc: QueryClient
let requests: { method: string; url: string; body?: unknown }[]

function render() {
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(SettingsDialog, { section: "identities", onSection: () => {}, onClose: () => {} }))))
}

beforeEach(() => {
  requests = []
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.agentSettings, settingsInfo())
  qc.setQueryData(keys.health, { provider: "local" })
  qc.setQueryData(keys.identities, [identity(DEFAULT_IDENTITY_ID, "Default", { color: "slate" }), acme()])
  qc.setQueryData(keys.projects, [project("prj_app", "app", "idn_acme"), project("prj_site", "site"), project("prj_blog", "blog")])
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, url, body })
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })
    if (method === "POST" && url === "/api/identities/detect") return json(detection)
    if (method === "POST" && url === "/api/identities/import") return json({ identity: identity("idn_cat", "octocat"), created: true, lines: ["Made the octocat identity for octocat.", "site: now uses the octocat identity."] }, 201)
    if (method === "POST" && url === "/api/identities") return json(identity("idn_new", body.name, body), 201)
    if (method === "PATCH" && url === "/api/identities/idn_acme") return json({ ...acme(), ...body })
    if (method === "PUT" && url === "/api/identities/idn_acme/tokens") return json(acme())
    if (method === "DELETE" && url.startsWith("/api/identities/idn_acme")) return json({ movedProjectIds: ["prj_app"] })
    return new Promise(() => {})
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  while (currentConfirm()) settleConfirm(currentConfirm()!.id, false)
})

const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
const buttons = (label: string) => [...document.querySelectorAll("button")].filter((b) => b.textContent?.trim() === label)
const saveButton = () => {
  for (const f of document.querySelectorAll("form")) f.noValidate = true
  return buttons("Save")[0]!
}
const card = (name: string) => document.querySelector<HTMLElement>(`[data-identity-card="${name}"]`)!
const unsaved = () => document.querySelector("[data-testid=unsaved-count]")?.textContent ?? null
const writes = () => requests.filter((r) => r.method !== "GET")
const click = async (el: Element | null | undefined) => {
  act(() => (el as HTMLElement).click())
  await settle()
}
/** Type into a controlled input the way React hears it. */
const type = async (el: HTMLInputElement, value: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await settle()
}

describe("Settings › Identities", () => {
  it("shows each identity's account, owners, author and token fingerprint, never a token", async () => {
    render()
    await settle()
    const text = card("Acme").textContent!
    expect(text).toContain("octo-acme")
    expect(text).toContain("acme-corp")
    expect(text).toContain("Acme Octo <octo@acme.dev>")
    expect(text).toContain("verified on octo-acme")
    expect(text).toContain("100da730fa2f")
    expect(card("Default").textContent).toContain("Settings › Credentials")
  })

  it("an edit and a pasted token are a draft until Save, which sends the token once and never shows it", async () => {
    render()
    await settle()
    await click(card("Acme").querySelector("[data-testid=identity-edit]"))
    await type(card("Acme").querySelector<HTMLInputElement>("input[placeholder=Acme]")!, "Acme Corp")
    const token = card("Acme").querySelector<HTMLInputElement>("[data-testid=identity-token]")!
    expect(token.type).toBe("password")
    await type(token, PASTED)
    expect(writes()).toEqual([])
    expect(unsaved()).toBe("2 unsaved changes")
    expect(document.querySelector('[data-section=identities] [title="Unsaved changes"]')).not.toBeNull()

    await click(saveButton())
    expect(writes()).toEqual([
      { method: "PATCH", url: "/api/identities/idn_acme", body: { name: "Acme Corp" } },
      { method: "PUT", url: "/api/identities/idn_acme/tokens", body: { owner: "", token: PASTED } },
    ])
    expect(unsaved()).toBeNull()
    expect(document.body.innerHTML).not.toContain(PASTED)
  })

  it("typing a field back to its saved value leaves nothing to save", async () => {
    render()
    await settle()
    await click(card("Acme").querySelector("[data-testid=identity-edit]"))
    const owners = card("Acme").querySelector<HTMLInputElement>("input[placeholder='acme-corp, octo-acme']")!
    await type(owners, "acme-corp, octo-acme")
    expect(unsaved()).toBe("1 unsaved change")
    await type(owners, "Acme-Corp")
    expect(unsaved()).toBeNull()
  })

  it("Detect only reads; a ticked proposal is imported on Save, with the projects left ticked", async () => {
    render()
    await settle()
    await click(document.querySelector("[data-testid=identity-detect]"))
    expect(writes()).toEqual([{ method: "POST", url: "/api/identities/detect", body: { online: true } }])
    const proposal = document.querySelector<HTMLElement>('[data-proposal="octocat"]')!
    expect(proposal.textContent).toContain("Octo Cat <octocat@example.com>")
    expect(proposal.textContent).toContain("a new identity")

    await click(proposal.querySelector("[data-testid=import-octocat]"))
    expect(unsaved()).toBe("1 unsaved change")
    // Leave blog where it is.
    await click([...proposal.querySelectorAll("label")].find((l) => l.textContent?.includes("blog"))!.querySelector("input"))
    expect(writes()).toHaveLength(1)

    await click(saveButton())
    expect(writes().at(-1)).toEqual({ method: "POST", url: "/api/identities/import", body: { login: "octocat", projects: ["prj_site"] } })
    expect(document.querySelector("[data-testid=identity-import-log]")!.textContent).toContain("site: now uses the octocat identity.")
    expect(unsaved()).toBeNull()
  })

  it("Delete waits for Save and says where its projects go; Add makes one on Save", async () => {
    render()
    await settle()
    await click(card("Acme").querySelector("[data-testid=identity-edit]"))
    await click(card("Acme").querySelector("[data-testid=identity-delete]"))
    expect(card("Acme").textContent).toContain("Deleted when you save; app moves to Default.")
    await click(document.querySelector("[data-testid=identity-add]"))
    await type(card("new").querySelector<HTMLInputElement>("input[placeholder=Acme]")!, "Personal")
    expect(writes()).toEqual([])
    expect(unsaved()).toBe("2 unsaved changes")

    await click(saveButton())
    expect(writes()).toEqual(
      expect.arrayContaining([
        { method: "DELETE", url: "/api/identities/idn_acme?moveProjects=1" },
        { method: "POST", url: "/api/identities", body: { name: "Personal", color: expect.any(String) } },
      ]),
    )
    expect(document.querySelector('[data-identity-card="new"]')).toBeNull()
  })

  it("counts a draft's changes and reads owners as GitHub does", () => {
    expect(editCount({ name: "x", removeTokens: ["a", "b"], token: { owner: "", value: "t" } })).toBe(4)
    expect(editCount({})).toBe(0)
    expect(parseOwners("Acme-Corp,  octo-acme acme-corp")).toEqual(["acme-corp", "octo-acme"])
  })
})
