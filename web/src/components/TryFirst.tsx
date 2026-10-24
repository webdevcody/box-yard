// Zen's first step once setup is done: a few plain-English requests to start from. Picking one puts it in the
// Composer without sending it, with the part to change selected, so the user learns to just type what they want.
import { useState } from "react"
import { Bot } from "lucide-react"
import { useAgentSettings, useRecentRepos } from "../lib/queries"
import { localFlag } from "../lib/localFlag"
import { cx } from "./ui"

/** Stands in for a repo until GitHub is connected. Picking a prompt selects it, so typing replaces it. */
export const REPO_PLACEHOLDER = "<owner/repo>"

/** `{repo}` becomes the chosen repo, or REPO_PLACEHOLDER. */
export const TRY_FIRST_PROMPTS = [
  "Add my {repo} repo as a project and list its open GitHub issues",
  "Pick the easiest open issue in {repo} and fix it in a PR",
  "Look through {repo} and tell me the 3 riskiest parts of the code",
  "Every weekday at 9am, summarize what's waiting on me",
]

const done = localFlag("box-yard:try-first-done")
/** Hidden for good in this browser: dismissed, or a first message was sent. */
export const useTryFirstDone = done.use
export const setTryFirstDone = done.set
/** Called on every send, so it only writes the first time. */
export const markTryFirstDone = () => {
  if (!done.read()) done.set(true)
}

const chip = "min-h-11 max-w-full rounded-full border px-3.5 text-sm wrap-anywhere transition sm:min-h-8"

/**
 * The empty Zen chat. `ready` is false while setup was skipped with something still missing, so it doesn't say
 * "You're set". With GitHub connected, the token's most recently pushed repos are chips and fill in the prompts.
 */
export function TryFirst({
  ready,
  github,
  needsGithub,
  onPick,
  onGithub,
}: {
  ready: boolean
  /** A GitHub token is in effect, so the server can list the user's repos. */
  github: boolean
  needsGithub: boolean
  onPick: (text: string, select?: string) => void
  onGithub: () => void
}) {
  const agent = useAgentSettings().data
  // Only a name the user saved: the built-in default isn't theirs.
  const name = agent && agent.sources.ownerName !== "default" ? agent.settings.ownerName.trim() : ""
  const repos = useRecentRepos({ enabled: github }).data?.repos ?? []
  const [picked, setPicked] = useState<string | null>(null)
  const repo = picked && repos.includes(picked) ? picked : (repos[0] ?? null)

  const pick = (template: string) => {
    const text = template.replace("{repo}", repo ?? REPO_PLACEHOLDER)
    onPick(text, repo ? undefined : REPO_PLACEHOLDER)
  }

  return (
    <div className="flex flex-col items-center pt-[10dvh] text-center" data-testid="try-first">
      <Bot className="h-6 w-6 text-yard-400" aria-hidden />
      <h2 className="mt-3 max-w-md text-lg font-semibold text-balance text-zinc-50">
        {ready && `You're set${name ? `, ${name}` : ""}. `}Just tell the Coordinator what you want.
      </h2>
      <p className="mt-1.5 max-w-md text-sm text-zinc-400">Pick one to start from. It goes in the box below, so you can edit it before you send it.</p>
      {repos.length > 0 && (
        <div role="group" aria-label="Your recent repos" className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <span className="text-xs text-zinc-500">Your repos</span>
          {repos.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={r === repo}
              onClick={() => setPicked(r)}
              className={cx(chip, r === repo ? "border-yard-500/50 bg-yard-500/10 text-yard-50" : "border-zinc-800 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-900")}
            >
              {r}
            </button>
          ))}
        </div>
      )}
      <div className="mt-4 grid w-full max-w-xl gap-2 sm:grid-cols-2">
        {TRY_FIRST_PROMPTS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => pick(t)}
            className="min-h-11 rounded-xl border border-zinc-800 px-3.5 py-2.5 text-left text-sm leading-snug text-zinc-200 wrap-anywhere transition hover:border-zinc-700 hover:bg-zinc-900"
          >
            <PromptText template={t} repo={repo} />
          </button>
        ))}
      </div>
      <p className="mt-4 max-w-md text-xs leading-relaxed text-zinc-500">
        The Coordinator creates projects, starts agents on their own boxes, and reports back. Ask in plain English.
      </p>
      {needsGithub && (
        <p className="mt-2 text-xs text-zinc-500">
          Agents need a GitHub token to push branches and open PRs.{" "}
          <button type="button" onClick={onGithub} className="text-yard-400 underline decoration-yard-400/40 underline-offset-2 hover:decoration-yard-400">
            Add one
          </button>
        </p>
      )}
      <button type="button" onClick={() => setTryFirstDone(true)} className="mt-2 min-h-11 px-3 text-xs text-zinc-500 transition hover:text-zinc-300 sm:min-h-8">
        Hide these examples
      </button>
    </div>
  )
}

/** A prompt with its repo (or the placeholder to replace) set apart. */
function PromptText({ template, repo }: { template: string; repo: string | null }) {
  const [before, after] = template.split("{repo}")
  if (after === undefined) return template
  return (
    <>
      {before}
      {repo ? <span className="inline-block max-w-full font-medium text-zinc-50">{repo}</span> : <span className="font-mono text-[0.8125rem] text-yard-400">{REPO_PLACEHOLDER}</span>}
      {after}
    </>
  )
}
