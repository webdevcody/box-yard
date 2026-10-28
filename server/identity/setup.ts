import { BadRequestError } from "../store.js"
import { errorMessage } from "../util/retry.js"
import type { Runner } from "../../shared/runner.js"
import type { CoordinatorSees, Identity, IdentityColor, IdentityDetection } from "../../shared/identities.js"
import type { Identities } from "./identities.js"
import type { IdentityDetector } from "./detect.js"

// Identities from references (docs/identities.md › Set up from this computer): create_identity, update_identity and
// import_detected_identity name a gh account or a key file, and the server reads the value itself, so a token or a
// private key never passes through the model. Nothing here returns one: only logins, fingerprints and paths.

export interface IdentityRefs {
  /** "gh:<login>": gh's token for that account, for every owner the identity serves (or `tokenOwner`). */
  githubTokenRef?: string
  tokenOwner?: string
  /** "file:~/.ssh/<key>" or "agent:<fingerprint>"; null removes the identity's signing key. */
  signingKeyRef?: string | null
  signingProgram?: string | null
  requireSigned?: boolean
}

/** Save the token and signing key the references name. One line per change. */
export async function applyRefs(ids: Identities, detector: IdentityDetector, id: string, refs: IdentityRefs): Promise<string[]> {
  const lines: string[] = []
  if (refs.githubTokenRef) {
    const t = await detector.tokenFromRef(refs.githubTokenRef)
    const owner = (refs.tokenOwner ?? "").toLowerCase()
    const after = await ids.saveToken(id, { owner, token: t.token }, `gh:${t.host}:${t.login}`)
    lines.push(`Saved gh's token for ${t.login}, for ${owner || "every owner"} (fingerprint ${after.tokens.find((x) => x.owner === owner)?.fingerprint ?? "?"}).`)
  }
  if (refs.signingKeyRef === null) {
    if (ids.require(id).signing) {
      ids.removeSigning(id)
      lines.push("Removed its signing key.")
    }
  } else if (refs.signingKeyRef) {
    const current = ids.require(id)
    const s = await detector.signingFromRef(refs.signingKeyRef, { program: refs.signingProgram, requireSigned: refs.requireSigned })
    // A turn on a box holds the identity's key file: never one that also logs this computer in to its servers.
    const hereOnly = current.runners !== null && current.runners.every((r) => r === "local")
    if (s.loginKey && !hereOnly) {
      throw new BadRequestError(
        `${s.label} is also a key this computer logs in to SSH servers with, and the ${current.name} identity's projects may run on boxes, which would each hold a copy of it. ` +
          `Give the identity a signing key of its own (ssh-keygen -t ed25519 -N "" -C box-yard-signing -f ~/.ssh/box_yard_signing, then add the .pub on GitHub as a Signing Key), or keep its projects on this computer (runners: ["local"]).`,
      )
    }
    const after = await ids.saveSigning(id, s.input, refs.signingKeyRef)
    const sig = after.signing!
    lines.push(`Saved its signing key ${sig.fingerprint}: ${s.input.kind === "file" ? `a copy of ${s.label}, kept encrypted` : `in this computer's SSH agent${sig.program ? `, signing through ${sig.program}` : ""}`}${sig.requireSigned ? "; requireSigned is on" : ""}.`)
  } else if (refs.requireSigned !== undefined) {
    ids.setRequireSigned(id, { requireSigned: refs.requireSigned })
    lines.push(`requireSigned is ${refs.requireSigned ? "on" : "off"}.`)
  }
  return lines
}

/** create_identity: the identity and what its references name, or nothing at all when one can't be read. */
export async function createWithRefs(ids: Identities, detector: IdentityDetector, fields: unknown, refs: IdentityRefs): Promise<{ identity: Identity; lines: string[] }> {
  const created = ids.create(fields)
  try {
    const lines = await applyRefs(ids, detector, created.id, refs)
    return { identity: ids.require(created.id), lines }
  } catch (err) {
    ids.delete(created.id, { moveProjects: true })
    throw err
  }
}

export interface ImportInput {
  /** The gh account a proposal is for. */
  login: string
  name?: string
  color?: IdentityColor
  owners?: string[]
  author?: { name: string; email: string } | null
  runners?: Runner[] | null
  coordinatorSees?: CoordinatorSees
  /** Instead of the proposal's signing key: another reference, or null for none. */
  signingKeyRef?: string | null
  signingProgram?: string | null
  requireSigned?: boolean
  /** Projects to give it (ids or names); the proposal's when left out. */
  projects?: string[]
}

const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>

/**
 * import_detected_identity: a detection proposal becomes an identity (or updates the one Box Yard has for the login).
 * The token and key are read again by reference, here; the proposal only supplies the defaults. A signing key that
 * detection warned about (it also logs in) is left out unless asked for. `assign` moves one project and returns a
 * line; `mayUpdate` throws when the caller may not change an existing identity.
 */
export async function importDetected(
  ids: Identities,
  detector: IdentityDetector,
  detection: IdentityDetection,
  input: ImportInput,
  assign: (projectRef: string, identityId: string) => string | Promise<string>,
  o: { mayUpdate?: (i: Identity) => void } = {},
): Promise<{ identity: Identity; created: boolean; lines: string[] }> {
  const p = detection.proposals.find((x) => x.login.toLowerCase() === input.login.toLowerCase())
  if (!p) throw new BadRequestError(`Detection found no gh account "${input.login}" on this computer${detection.proposals.length ? ` (it found ${detection.proposals.map((x) => x.login).join(", ")})` : ""}. Sign in to it with \`gh auth login\`, then run detect_identities again.`)
  const lines: string[] = []
  let signingKeyRef = input.signingKeyRef
  if (signingKeyRef === undefined && p.signing?.ref && !p.signing.problem) {
    if (p.signing.warning) lines.push(`Left out the signing key ${p.signing.fingerprint}: ${p.signing.warning}`)
    else signingKeyRef = p.signing.ref
  }
  const signingProgram = input.signingProgram ?? (signingKeyRef && signingKeyRef === p.signing?.ref ? p.signing.program : null)
  // An agent key signs only on this computer, so a new identity with one runs its projects here.
  const runners = input.runners !== undefined ? input.runners : signingKeyRef?.startsWith("agent:") ? (["local"] as Runner[]) : undefined
  // Looked up now, not from the proposal: the detection may be from before an earlier import.
  const existing = (p.existing && ids.get(p.existing.id)) || ids.list().find((i) => !i.isDefault && i.githubLogin?.toLowerCase() === p.login.toLowerCase()) || null
  let identity: Identity
  if (existing) {
    o.mayUpdate?.(existing)
    ids.update(
      existing.id,
      defined({
        name: input.name,
        color: input.color,
        owners: input.owners ?? [...new Set([...existing.owners.map((x) => x.toLowerCase()), ...p.owners])],
        author: input.author !== undefined ? input.author : existing.author ? undefined : p.author && { name: p.author.name, email: p.author.email },
        runners,
        coordinatorSees: input.coordinatorSees,
      }),
    )
    lines.push(`Updated the ${existing.name} identity (${p.login}).`)
    const hasToken = existing.tokens.some((t) => t.owner === "" && t.readable)
    lines.push(
      ...(await applyRefs(ids, detector, existing.id, {
        githubTokenRef: hasToken ? undefined : p.tokenRef,
        signingKeyRef: input.signingKeyRef !== undefined || !existing.signing ? signingKeyRef : undefined,
        signingProgram,
        requireSigned: input.requireSigned,
      })),
    )
    identity = existing
  } else {
    const fields = defined({
      name: input.name ?? p.name,
      color: input.color,
      owners: input.owners ?? p.owners,
      author: input.author !== undefined ? input.author : p.author ? { name: p.author.name, email: p.author.email } : null,
      runners,
      coordinatorSees: input.coordinatorSees,
    })
    const r = await createWithRefs(ids, detector, fields, { githubTokenRef: p.tokenRef, signingKeyRef, signingProgram, requireSigned: input.requireSigned })
    lines.push(`Made the ${r.identity.name} identity for ${p.login}.`, ...r.lines)
    identity = r.identity
  }
  for (const ref of input.projects ?? p.projects.map((x) => x.id)) {
    try {
      lines.push(await assign(ref, identity.id))
    } catch (err) {
      lines.push(`${ref}: not moved: ${errorMessage(err)}`)
    }
  }
  return { identity: ids.require(identity.id), created: !existing, lines }
}
