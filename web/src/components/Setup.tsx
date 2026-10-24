// First-run setup (the card Zen shows until the required keys are set) and Settings › Credentials. Keys go to the
// server and never come back: a field shows only whether its key is set and where it comes from.
import { useEffect, useId, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { Check, Copy, KeyRound, Play, X } from "lucide-react"
import { useAgentSettings, useSaveCredentials, useSaveSettings, useSetup, useTestCredential } from "../lib/queries"
import { Button, LineIcon, NewTabLink, cx, inputClass } from "./ui"
import { localFlag } from "../lib/localFlag"
import { Panel, Row, SourceHint } from "./SettingsDialog"
import { CREDENTIAL_INFO, GITHUB_TOKEN_SCOPES, SETUP_TOKEN_COMMAND, type CredentialKey, type CredentialStatus, type SetupStatus } from "../../../shared/setup"

// ------------------------------------------------------------------ "Skip for now" (this browser)

const skip = localFlag("box-yard:setup-skipped")
export const setSetupSkipped = skip.set
/** The setup card was put off in this browser: Zen shows the chat with a one-line reminder instead. */
export const useSetupSkipped = skip.use

/** Setup still needs something required (never in mock mode). Undefined while loading. */
export function useSetupNeeded(): { status: SetupStatus | undefined; needed: boolean } {
  const setup = useSetup()
  return { status: setup.data, needed: Boolean(setup.data && !setup.data.ready) }
}

// ------------------------------------------------------------------ one credential

type TestState = { state: "running" } | { state: "ok" | "error"; text: string }

/**
 * A credential's control. Unset: a password input with Save and Test (the typed value, not saved). Saved: masked,
 * with Replace, Remove and Test. From env: masked and read-only (the env var wins), with Test.
 */
export function CredentialField({ k, status, id }: { k: CredentialKey; status: CredentialStatus; id: string }) {
  const info = CREDENTIAL_INFO[k]
  const save = useSaveCredentials()
  const test = useTestCredential()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState("")
  const [result, setResult] = useState<TestState | null>(null)
  const fromEnv = status.source === "env"
  const showInput = !fromEnv && (editing || status.state === "unset")

  // A save elsewhere (another tab, the other form) settles this one.
  useEffect(() => {
    setEditing(false)
    setValue("")
  }, [status.source])

  const submit = () => {
    const v = value.trim()
    if (!v) return
    save.mutate(
      { [k]: v },
      {
        onSuccess: () => {
          setValue("")
          setEditing(false)
        },
      },
    )
  }
  const runTest = () => {
    setResult({ state: "running" })
    test.mutate(
      { key: k, value: showInput ? value.trim() || undefined : undefined },
      {
        onSuccess: (r) => setResult({ state: r.ok ? "ok" : "error", text: r.message }),
        onError: (err) => setResult({ state: "error", text: err.message }),
      },
    )
  }
  const onKey = (e: ReactKeyboardEvent) => {
    // Enter saves this key, not a form around it.
    if (e.key === "Enter") {
      e.preventDefault()
      submit()
    }
    if (e.key === "Escape" && editing) {
      e.stopPropagation()
      setEditing(false)
      setValue("")
    }
  }

  return (
    <div className="space-y-2" data-credential={k}>
      {showInput ? (
        <input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          className={cx(inputClass, "font-mono")}
          placeholder={info.placeholder}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            if (result?.state !== "running") setResult(null)
          }}
          onKeyDown={onKey}
          aria-label={info.label}
          aria-describedby={`${id}-result`}
        />
      ) : (
        <div id={id} className="flex min-h-11 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm sm:min-h-9" data-key-masked>
          <KeyRound className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          <span className="font-mono tracking-widest text-zinc-400" aria-label={`${info.label} set (hidden)`}>
            ••••••••••••
          </span>
          <span className="ml-auto">
            <SourceHint source={fromEnv ? "env" : "ui"} changed={false} />
          </span>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {showInput ? (
          <>
            <Button type="button" variant="primary" size="sm" loading={save.isPending} disabled={!value.trim()} onClick={submit}>
              Save
            </Button>
            {editing && (
              <Button type="button" variant="ghost" size="sm" onClick={() => (setEditing(false), setValue(""), save.reset())}>
                Cancel
              </Button>
            )}
          </>
        ) : (
          !fromEnv && (
            <>
              <Button type="button" size="sm" onClick={() => (setEditing(true), setResult(null))}>
                Replace
              </Button>
              <Button type="button" size="sm" variant="danger" loading={save.isPending} onClick={() => save.mutate({ [k]: null }, { onSuccess: () => setResult(null) })} title={`Forget the saved ${info.label}`}>
                Remove
              </Button>
            </>
          )
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          loading={result?.state === "running"}
          disabled={showInput && !value.trim()}
          onClick={runTest}
          title={showInput ? "Check the key you typed, without saving it" : "Check the key in use"}
        >
          <Play className="h-3.5 w-3.5" /> Test
        </Button>
      </div>
      <div id={`${id}-result`} aria-live="polite">
        {fromEnv && <p className="text-xs leading-relaxed text-zinc-500">Set on the server by {info.env}, which always wins. Change it there.</p>}
        {save.error && <ResultLine ok={false} text={save.error.message} />}
        {result && result.state !== "running" && <ResultLine ok={result.state === "ok"} text={result.text} />}
      </div>
    </div>
  )
}

function ResultLine({ ok, text }: { ok: boolean; text: string }) {
  return (
    <p className={cx("flex items-start gap-1.5 text-xs leading-relaxed wrap-anywhere", ok ? "text-emerald-400" : "text-red-300")} data-key-test={ok ? "ok" : "error"}>
      <LineIcon icon={ok ? Check : X} className="h-3.5 w-3.5" />
      {text}
    </p>
  )
}

/** `claude setup-token` on its own line, with a copy button. */
export function SetupTokenCommand() {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <div className="mt-2 flex max-w-sm items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200">
        <span className="text-zinc-600 select-none">$ </span>
        {SETUP_TOKEN_COMMAND}
      </code>
      <button
        type="button"
        className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 sm:h-8 sm:w-8"
        aria-label={copied ? "Copied" : `Copy ${SETUP_TOKEN_COMMAND}`}
        title={copied ? "Copied" : "Copy"}
        onClick={() => void navigator.clipboard?.writeText(SETUP_TOKEN_COMMAND).then(() => setCopied(true), () => {})}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
}

const linkClass = "text-yard-400 underline decoration-yard-400/40 underline-offset-2 hover:decoration-yard-400"

/** Where to get each credential, in a sentence or two with its link. */
function CredentialHelp({ k }: { k: CredentialKey }) {
  const info = CREDENTIAL_INFO[k]
  const link = (
    <NewTabLink href={info.link.href} className={linkClass}>
      {info.link.label}
    </NewTabLink>
  )
  if (k === "claudeOauthToken")
    return (
      <>
        {info.help} Run this where Claude Code is installed, sign in, and paste the token it prints. {link}.
        <SetupTokenCommand />
      </>
    )
  if (k === "githubToken")
    return (
      <>
        {info.help} Give it the repos agents work on, with {GITHUB_TOKEN_SCOPES}. {link}.
      </>
    )
  return (
    <>
      {info.help} {link}.
    </>
  )
}

// ------------------------------------------------------------------ Claude: subscription or API key

type ClaudeKey = "claudeOauthToken" | "anthropicApiKey"
const CLAUDE_CHOICES: { key: ClaudeKey; label: string }[] = [
  { key: "claudeOauthToken", label: "Subscription" },
  { key: "anthropicApiKey", label: "API key" },
]

function ClaudeChoice({ status, id }: { status: SetupStatus; id: string }) {
  const [choice, setChoice] = useState<ClaudeKey>(status.claude.using ?? "claudeOauthToken")
  const both = status.credentials.claudeOauthToken.state === "set" && status.credentials.anthropicApiKey.state === "set"
  return (
    <div className="space-y-3">
      <div role="group" aria-label="How Claude signs in" className="inline-flex rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
        {CLAUDE_CHOICES.map((c) => {
          const on = choice === c.key
          const set = status.credentials[c.key].state === "set"
          return (
            <button
              key={c.key}
              type="button"
              aria-pressed={on}
              onClick={() => setChoice(c.key)}
              className={cx(
                "inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition sm:min-h-8",
                on ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:text-zinc-200",
              )}
            >
              {set && <Check className="h-3.5 w-3.5 text-emerald-400" aria-label="set" />}
              {c.label}
            </button>
          )
        })}
      </div>
      <div className="text-xs leading-relaxed text-zinc-400">
        <CredentialHelp k={choice} />
      </div>
      <CredentialField key={choice} k={choice} status={status.credentials[choice]} id={`${id}-${choice}`} />
      {both && <p className="text-xs text-zinc-500">Both are set, so Claude Code uses the API key.</p>}
    </div>
  )
}

// ------------------------------------------------------------------ the setup card (Zen)

function Step({ n, done, title, tag, help, children }: { n: number; done: boolean; title: string; tag?: string; help?: ReactNode; children: ReactNode }) {
  return (
    <li className="rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-4 sm:p-5" data-step-done={done || undefined}>
      <div className="flex items-start gap-3">
        <span
          className={cx(
            "grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums",
            done ? "bg-emerald-500/15 text-emerald-400" : "bg-zinc-800 text-zinc-300",
          )}
          aria-hidden
        >
          {done ? <Check className="h-3.5 w-3.5" /> : n}
        </span>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
            {tag && <span className="rounded bg-zinc-800 px-1.5 py-px text-[11px] text-zinc-400">{tag}</span>}
            {done && <span className="sr-only">(done)</span>}
          </div>
          {help && <div className="text-xs leading-relaxed text-zinc-400">{help}</div>}
          {children}
        </div>
      </div>
    </li>
  )
}

function OwnerNameField({ id }: { id: string }) {
  const info = useAgentSettings()
  const save = useSaveSettings()
  const name = info.data?.settings.ownerName ?? ""
  const source = info.data?.sources.ownerName
  const [value, setValue] = useState<string | null>(null)
  const draft = value ?? name
  const changed = value !== null && value.trim() !== name
  if (source === "env")
    return <p className="text-xs text-zinc-500">{name}: set on the server by BOXYARD_OWNER_NAME.</p>
  const submit = () => changed && save.mutate({ ownerName: draft.trim() }, { onSuccess: () => setValue(null) })
  return (
    <div className="space-y-2">
      <input
        id={id}
        className={inputClass}
        value={draft}
        maxLength={40}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            submit()
          }
        }}
        aria-label="Your name"
      />
      <Button type="button" size="sm" variant={changed ? "primary" : "subtle"} disabled={!changed || !draft.trim()} loading={save.isPending} onClick={submit}>
        Save
      </Button>
    </div>
  )
}

/** Zen's first-run card: the keys the Coordinator needs, in order, then the optional ones. */
export function SetupCard({ status, className }: { status: SetupStatus; className?: string }) {
  const id = useId()
  const owner = useAgentSettings().data?.sources.ownerName
  const set = (k: CredentialKey) => status.credentials[k].state === "set"
  let n = 0
  return (
    <div className={cx("scroll-thin min-h-0 flex-1 overflow-y-auto", className)} data-testid="setup-card">
      <div className="space-y-1.5 pt-8 pb-6 sm:pt-12">
        <h2 className="text-lg font-semibold text-zinc-50">Set up Box Yard</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          {status.boxes.required ? "Two keys" : "One key"} and the Coordinator is ready. Keys stay on this server: the browser never sees them again.
        </p>
      </div>
      <ol className="space-y-3">
        {status.boxes.required && (
          <Step n={++n} done={set("upstashBoxApiKey")} title={CREDENTIAL_INFO.upstashBoxApiKey.label} help={<CredentialHelp k="upstashBoxApiKey" />}>
            <CredentialField k="upstashBoxApiKey" status={status.credentials.upstashBoxApiKey} id={`${id}-box`} />
          </Step>
        )}
        <Step n={++n} done={status.claude.state === "set"} title="Claude">
          <ClaudeChoice status={status} id={`${id}-claude`} />
        </Step>
        <Step n={++n} done={set("githubToken")} title={CREDENTIAL_INFO.githubToken.label} tag="Recommended" help={<CredentialHelp k="githubToken" />}>
          <CredentialField k="githubToken" status={status.credentials.githubToken} id={`${id}-gh`} />
        </Step>
        <Step n={++n} done={owner !== undefined && owner !== "default"} title="Your name" tag="Optional" help="What the Coordinator, Captains and agents call you.">
          <OwnerNameField id={`${id}-owner`} />
        </Step>
      </ol>
      {status.restart.map((r) => (
        <p key={r} className="mt-4 rounded-lg border border-amber-900/40 bg-amber-950/30 px-3 py-2 text-xs leading-relaxed text-amber-200">
          {r}
        </p>
      ))}
      <div className="flex flex-col items-center gap-1 py-6 text-center">
        <Button type="button" variant="ghost" size="sm" onClick={() => setSetupSkipped(true)}>
          Skip for now
        </Button>
        <p className="text-xs text-zinc-600">Settings › Credentials has the same fields.</p>
      </div>
    </div>
  )
}

/** One line over the chat while setup isn't finished: what's missing, and the way back to it. */
export function SetupReminder({ status, onFinish, className }: { status: SetupStatus; onFinish: () => void; className?: string }) {
  return (
    <div className={cx("flex items-center gap-3 border-b border-amber-900/40 bg-amber-950/30 py-2 text-xs text-amber-200", className)} role="status" data-testid="setup-reminder">
      <span className="min-w-0 flex-1">Needs {status.missing.join(" and ")} before the Coordinator can work.</span>
      <Button type="button" size="sm" variant="ghost" className="shrink-0 text-amber-200 hover:text-amber-100" onClick={onFinish}>
        Finish setup
      </Button>
    </div>
  )
}

// ------------------------------------------------------------------ Settings › Credentials

export function CredentialsPanel({ fid }: { fid: (k: string) => string }) {
  const setup = useSetup()
  const s = setup.data
  return (
    <Panel section="credentials">
      {!s ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <>
          {s.mock && <p className="mb-4 text-xs text-zinc-500">Mock mode: nothing here is needed, and nothing calls a real service.</p>}
          {(["upstashBoxApiKey", "claudeOauthToken", "anthropicApiKey", "githubToken"] as const).map((k) => (
            <Row key={k} id={fid(`cred-${k}`)} label={CREDENTIAL_INFO[k].label} help={<CredentialHelp k={k} />}>
              <CredentialField k={k} status={s.credentials[k]} id={fid(`cred-${k}`)} />
            </Row>
          ))}
          {s.credentials.claudeOauthToken.state === "set" && s.credentials.anthropicApiKey.state === "set" && (
            <p className="mt-2 text-xs text-zinc-500">Both Claude credentials are set, so Claude Code uses the API key.</p>
          )}
          {s.restart.map((r) => (
            <p key={r} className="mt-4 rounded-lg border border-amber-900/40 bg-amber-950/30 px-3 py-2 text-xs leading-relaxed text-amber-200">
              {r}
            </p>
          ))}
        </>
      )}
    </Panel>
  )
}
