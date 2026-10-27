// A project's identity at a glance (docs/identities.md): its colour dot and name, in the sidebar's project rows,
// project settings and the task ⋯ details. Never in the project header (#83).
import type { Identity, IdentityColor } from "../../../shared/identities"
import { cx } from "./ui"

/** Literal classes, so Tailwind sees every one. */
export const IDENTITY_DOT: Record<IdentityColor, string> = {
  slate: "bg-slate-400",
  sky: "bg-sky-400",
  emerald: "bg-emerald-400",
  amber: "bg-amber-400",
  rose: "bg-rose-400",
  violet: "bg-violet-400",
  orange: "bg-orange-400",
  teal: "bg-teal-400",
}

/** "Acts as octo-acme (the Acme identity)", for titles and screen readers. */
export const identityTitle = (i: Pick<Identity, "name" | "isDefault" | "githubLogin">) =>
  i.isDefault ? `The Default identity: Settings › Credentials${i.githubLogin ? ` (${i.githubLogin})` : ""}` : `Acts as ${i.githubLogin ?? "no GitHub account yet"} (the ${i.name} identity)`

export function IdentityDot({ color, className }: { color: IdentityColor; className?: string }) {
  return <span aria-hidden className={cx("inline-block h-2 w-2 shrink-0 rounded-full", IDENTITY_DOT[color], className)} />
}

/**
 * Dot and name in a pill. `fold`: inside an `@container`, the name shows only when there's room for it (a narrow
 * sidebar keeps the dot, still in its pill, so it never reads as the plain amber "needs you" dot next to it).
 */
export function IdentityBadge({ identity, fold, className }: { identity: Pick<Identity, "name" | "color" | "isDefault" | "githubLogin">; fold?: boolean; className?: string }) {
  return (
    <span
      className={cx("inline-flex min-w-0 items-center gap-1.5 rounded-full border border-zinc-700/80 text-[11px] text-zinc-400", fold ? "p-[3px] @min-[13rem]:px-1.5 @min-[13rem]:py-px" : "px-1.5 py-px", className)}
      title={identityTitle(identity)}
      data-identity={identity.name}
    >
      <IdentityDot color={identity.color} />
      <span className={cx("truncate", fold && "hidden @min-[13rem]:inline")}>{identity.name}</span>
      {fold && <span className="sr-only">{identityTitle(identity)}</span>}
    </span>
  )
}
