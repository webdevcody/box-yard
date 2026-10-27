import { describe, expect, it } from "vitest"
import { IdentityDetector } from "../server/identity/detect.js"
import { DEFAULT_IDENTITY_ID } from "../shared/identities.js"

// Identity detection on this computer's real gh, git and ssh setup (docs/identities.md › Set up from this computer).
// Opt-in, and read-only: it changes nothing, makes no identity, and stays offline (GitHub isn't asked; `gh auth status`
// checks its own tokens as it always does). It prints only logins, owners, emails and fingerprints.
//
//   BOXYARD_DETECT_E2E=1 npx vitest run test/identity-detect-here.e2e.test.ts
//
// BOXYARD_DETECT_E2E_ONLINE=1 also asks GitHub with each gh account's own token (orgs, emails, keys, push access).

const enabled = process.env.BOXYARD_DETECT_E2E === "1"
const online = process.env.BOXYARD_DETECT_E2E_ONLINE === "1"

/** Shapes a GitHub token or private key takes. Tested as booleans, so a failure never prints what matched. */
const SECRET_SHAPES = [/\bgh[opsur]_[A-Za-z0-9]{8,}/, /\bgithub_pat_[A-Za-z0-9_]{8,}/, /PRIVATE KEY/, /-----BEGIN/]

describe.skipIf(!enabled)("identity detection on this computer (BOXYARD_DETECT_E2E=1)", () => {
  it("reads gh, git and ssh here, proposes identities by reference, and holds no token or key", async () => {
    const detector = new IdentityDetector()
    const d = await detector.detect({
      projects: [{ id: "prj_here", name: "box-yard", repo: "webdevcody/box-yard", identityId: DEFAULT_IDENTITY_ID }],
      identities: [{ id: DEFAULT_IDENTITY_ID, name: "Default", isDefault: true, githubLogin: null }],
      online,
    })
    const json = JSON.stringify(d)
    for (const shape of SECRET_SHAPES) expect(shape.test(json), `the detection holds something shaped like ${shape}`).toBe(false)
    for (const p of d.proposals) {
      expect(p.tokenRef).toMatch(/^gh:[a-z0-9.-]+:[A-Za-z0-9-]+$/)
      if (p.signing?.ref) expect(p.signing.ref).toMatch(/^(file|agent):/)
    }
    expect(d.online).toBe(online)

    const scope = (s: string) => (s === "global" ? "global" : `includeIf ${s.split(":")[0]}`)
    const summary = {
      online: d.online,
      accounts: d.accounts.map((a) => ({ host: a.host, login: a.login, active: a.active, protocol: a.protocol, storage: a.storage?.includes("/") ? "file" : a.storage, scopes: a.scopes, problem: a.problem && "yes" })),
      authors: d.authors.map((a) => ({
        scope: scope(a.scope),
        name: a.name,
        email: a.email,
        signing: a.signing && { format: a.signing.format, kind: a.signing.kind, fingerprint: a.signing.fingerprint, problem: a.signing.problem && "yes", warning: a.signing.warning && "yes" },
        sshKeyFingerprint: a.sshKeyFingerprint,
        repoOwners: a.repoOwners,
      })),
      sshHosts: d.sshHosts.map((h) => ({ alias: h.alias, keyFingerprint: h.keyFingerprint, agent: Boolean(h.agent) })),
      credentialHelpers: d.credentialHelpers,
      proposals: d.proposals.map((p) => ({ login: p.login, owners: p.owners, author: p.author?.email ?? null, signing: p.signing?.fingerprint ?? null, projects: p.projects.map((x) => x.name), isDefaultToday: p.isDefaultToday })),
      unmatched: d.unmatched.map((x) => x.name),
      notes: d.notes.length,
    }
    console.log(JSON.stringify(summary, null, 2))
  }, 60_000)
})
