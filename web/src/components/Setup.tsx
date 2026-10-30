// First-run setup (the card Zen shows until the required keys are set) and Settings › Credentials. Keys go to the
// server and never come back: a field shows only whether its key is set and where it comes from.
import { useEffect, useId, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { Check, Cloud, Container, Copy, KeyRound, Laptop, Minus, Play, RefreshCw, ShieldAlert, Undo2, X } from "lucide-react"
import { useAgentSettings, useCheckLocal, useSaveCredentials, useSaveRunnerChoice, useSaveSettings, useSettings, useSetup, useTestCredential } from "../lib/queries"
import { Button, LineIcon, NewTabLink, cx, inputClass } from "./ui"
import { localFlag } from "../lib/localFlag"
import { Panel, Row, SourceHint } from "./SettingsDialog"
import { useDraft, useInSettingsDraft } from "../lib/settingsDraft"
import type { SettingsSection } from "../lib/settingsNav"
import {
  CODEX_AUTH_FILE,
  CODEX_LOGIN_COMMAND,
  CREDENTIAL_INFO,
  GITHUB_TOKEN_SCOPES,
  LOCAL_TOOL_INFO,
  SETUP_TOKEN_COMMAND,
  type CredentialKey,
  type CredentialStatus,
  type LocalTool,
  type SetupStatus,
} from "../../../shared/setup"
import { LOCAL_UNSANDBOXED, type Runner } from "../../../shared/runner"

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

/** Credentials that are a whole file, not a one-line key: a text box takes them. */
const MULTILINE_CREDENTIALS: CredentialKey[] = ["codexAuthJson"]

/**
 * A credential's control. Unset: a password input (a text box for a file like Codex's auth.json) with Save and Test
 * (the typed value, not saved). Saved: masked, with Replace, Remove and Test. From env: masked and read-only (the env var wins), with Test. Inside the Settings
 * dialog a typed key or a Remove is a draft that the dialog's Save writes, so the field has no Save of its own.
 */
export function CredentialField({ k, status, id, section = "credentials" }: { k: CredentialKey; status: CredentialStatus; id: string; section?: SettingsSection }) {
  const info = CREDENTIAL_INFO[k]
  const save = useSaveCredentials()
  const test = useTestCredential()
  const drafted = useInSettingsDraft()
  // In Settings: a typed key (string) or a removal (null) waiting for Save.
  const [edit, setEdit] = useDraft<string | null | undefined>(`cred-${k}`, section, undefined, async (v) => {
    if (v !== undefined) await save.mutateAsync({ [k]: v === null ? null : v.trim() })
  })
  const [editing, setEditing] = useState(false)
  const [typed, setTyped] = useState("")
  const value = drafted ? (edit ?? "") : typed
  const setValue = (v: string) => (drafted ? setEdit(v.trim() ? v : undefined) : setTyped(v))
  const removing = drafted && edit === null
  const [result, setResult] = useState<TestState | null>(null)
  const fromEnv = status.source === "env"
  // The Codex login is a whole JSON file (~/.codex/auth.json), pasted into a text box rather than a one-line password field.
  const multiline = MULTILINE_CREDENTIALS.includes(k)
  // GitHub only: this computer's `gh auth` login stands in until a token is saved here.
  const fromGh = status.source === "gh"
  const showInput = !fromEnv && !removing && (editing || typeof edit === "string" || status.state === "unset")

  // A save elsewhere (another tab, the other form) settles this one.
  useEffect(() => {
    setEditing(false)
    setTyped("")
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
  const cancel = () => {
    setEditing(false)
    if (drafted) setEdit(undefined)
    else setTyped("")
    save.reset()
  }
  const onKey = (e: ReactKeyboardEvent) => {
    // Enter saves this key, not a form around it (⌘/Ctrl+Enter in a file's text box, where Enter is a new line).
    // In Settings it's the dialog's Save, like any other field.
    if (e.key === "Enter" && !drafted && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submit()
    }
    if (e.key === "Escape" && (editing || value)) {
      e.stopPropagation()
      cancel()
    }
  }
  const inputProps = {
    id,
    autoComplete: "off",
    spellCheck: false,
    placeholder: info.placeholder,
    value,
    onChange: (e: { target: { value: string } }) => {
      setValue(e.target.value)
      if (result?.state !== "running") setResult(null)
    },
    onKeyDown: onKey,
    "aria-label": info.label,
    "aria-describedby": `${id}-result`,
  }

  return (
    <div className="space-y-2" data-credential={k}>
      {showInput ? (
        multiline ? (
          <textarea {...inputProps} rows={5} className={cx(inputClass, "min-h-28 resize-y font-mono text-xs leading-5")} />
        ) : (
          <input {...inputProps} type="password" className={cx(inputClass, "font-mono")} />
        )
      ) : removing ? (
        <p id={id} className="flex min-h-11 items-center rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 text-xs text-amber-200 sm:min-h-9" data-key-removing>
          Removed when you save.
        </p>
      ) : (
        <div id={id} className="flex min-h-11 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm sm:min-h-9" data-key-masked>
          <KeyRound className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          <span className="font-mono tracking-widest text-zinc-400" aria-label={`${info.label} set (hidden)`}>
            ••••••••••••
          </span>
          <span className="ml-auto">
            {fromGh ? (
              <span className="rounded bg-zinc-800 px-1.5 py-px text-[11px] text-zinc-400">gh auth</span>
            ) : (
              <SourceHint source={fromEnv ? "env" : "ui"} changed={false} />
            )}
          </span>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {removing ? (
          <Button type="button" size="sm" variant="ghost" onClick={cancel}>
            <Undo2 className="h-3.5 w-3.5" /> Keep it
          </Button>
        ) : showInput ? (
          <>
            {!drafted && (
              <Button type="button" variant="primary" size="sm" loading={save.isPending} disabled={!value.trim()} onClick={submit}>
                Save
              </Button>
            )}
            {(editing || (drafted && value && status.state === "set")) && (
              <Button type="button" variant="ghost" size="sm" onClick={cancel}>
                {drafted ? "Keep the saved key" : "Cancel"}
              </Button>
            )}
          </>
        ) : fromGh ? (
          <Button type="button" size="sm" onClick={() => (setEditing(true), setResult(null))}>
            Use a token instead
          </Button>
        ) : (
          !fromEnv && (
            <>
              <Button type="button" size="sm" onClick={() => (setEditing(true), setResult(null))}>
                Replace
              </Button>
              <Button
                type="button"
                size="sm"
                variant="danger"
                loading={save.isPending}
                onClick={() => (drafted ? (setEdit(null), setResult(null)) : save.mutate({ [k]: null }, { onSuccess: () => setResult(null) }))}
                title={drafted ? `Forget the saved ${info.label} when you save` : `Forget the saved ${info.label}`}
              >
                Remove
              </Button>
            </>
          )
        )}
        {!removing && <Button
          type="button"
          size="sm"
          variant="ghost"
          loading={result?.state === "running"}
          disabled={showInput && !value.trim()}
          onClick={runTest}
          title={showInput ? "Check the key you typed, without saving it" : "Check the key in use"}
        >
          <Play className="h-3.5 w-3.5" /> Test
        </Button>}
      </div>
      <div id={`${id}-result`} aria-live="polite">
        {drafted && edit !== undefined && <SourceHint changed />}
        {fromEnv && <p className="text-xs leading-relaxed text-zinc-500">Set on the server by {info.env}, which always wins. Change it there.</p>}
        {fromGh && !showInput && <p className="text-xs leading-relaxed text-zinc-500">Using this computer's gh login. A token saved here wins over it.</p>}
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

/** A shell command on its own line, with a copy button (`claude setup-token` by default). */
export function SetupTokenCommand({ command = SETUP_TOKEN_COMMAND }: { command?: string }) {
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
        {command}
      </code>
      <button
        type="button"
        className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 sm:h-8 sm:w-8"
        aria-label={copied ? "Copied" : `Copy ${command}`}
        title={copied ? "Copied" : "Copy"}
        onClick={() => void navigator.clipboard?.writeText(command).then(() => setCopied(true), () => {})}
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
  if (k === "codexAuthJson")
    return (
      <>
        {info.help} Run this on a computer with a browser, sign in, then paste all of <span className="font-mono">{CODEX_AUTH_FILE}</span>. {link}.
        <SetupTokenCommand command={CODEX_LOGIN_COMMAND} />
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
  return (
    <SignInChoice
      status={status}
      id={id}
      label="How Claude signs in"
      choices={CLAUDE_CHOICES}
      start={status.claude.using ?? "claudeOauthToken"}
      bothNote="Both are set, so Claude Code uses the API key."
    />
  )
}

// ------------------------------------------------------------------ Codex: ChatGPT login or API key

type CodexKey = "codexAuthJson" | "codexApiKey"
const CODEX_CHOICES: { key: CodexKey; label: string }[] = [
  { key: "codexAuthJson", label: "ChatGPT login" },
  { key: "codexApiKey", label: "API key" },
]
const CODEX_BOTH = "Both are set, so Codex uses the ChatGPT login."

function CodexChoice({ status, id }: { status: SetupStatus; id: string }) {
  return <SignInChoice status={status} id={id} label="How Codex signs in" choices={CODEX_CHOICES} start={status.codex?.using ?? "codexAuthJson"} bothNote={CODEX_BOTH} />
}

/** Two ways to sign one CLI in (a plan's login or an API key): a toggle, the chosen one's help and its field. */
function SignInChoice<K extends CredentialKey>({
  status,
  id,
  label,
  choices,
  start,
  bothNote,
}: {
  status: SetupStatus
  id: string
  label: string
  choices: { key: K; label: string }[]
  start: K
  bothNote: string
}) {
  const [choice, setChoice] = useState<K>(start)
  const both = choices.every((c) => status.credentials[c.key]?.state === "set")
  return (
    <div className="space-y-3">
      <div role="group" aria-label={label} className="inline-flex rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
        {choices.map((c) => {
          const on = choice === c.key
          const set = status.credentials[c.key]?.state === "set"
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
      <CredentialField key={choice} k={choice} status={status.credentials[choice] ?? UNSET} id={`${id}-${choice}`} />
      {both && <p className="text-xs text-zinc-500">{bothNote}</p>}
    </div>
  )
}

/** A credential the server didn't list (an older server) reads as unset. */
const UNSET: CredentialStatus = { state: "unset", source: null }

// ------------------------------------------------------------------ where agents run: this computer, Upstash boxes or Docker

const RUNNER_CHOICES: { runner: Runner; icon: typeof Laptop; title: string; body: string; needs: string }[] = [
  {
    runner: "local",
    icon: Laptop,
    title: "This computer",
    body: "Agents run right here, with this computer's claude, gh and browser.",
    needs: "No account needed",
  },
  {
    runner: "box",
    icon: Cloud,
    title: "Upstash boxes",
    body: "Each agent works in its own isolated cloud box.",
    needs: "Needs an Upstash Box API key",
  },
  {
    runner: "docker",
    icon: Container,
    title: "Docker containers",
    body: "Each project's agents work in an isolated container on this computer.",
    needs: "Needs Docker running and a Claude key",
  },
]

/**
 * A card per place agents can run; new projects follow the choice. In first-run setup picking one saves it
 * right away; in Settings it's a draft until the dialog's Save.
 */
export function RunnerChoice({ status, compact }: { status: SetupStatus; compact?: boolean }) {
  const save = useSaveRunnerChoice()
  const drafted = useInSettingsDraft()
  const [choice, setChoice, changed] = useDraft<Runner | null>("runner", "credentials", status.runner.choice, (r) => r && save.mutateAsync(r))
  const current = save.isPending && !drafted ? save.variables : choice
  return (
    <div className="space-y-2">
      <div role="group" aria-label="Where agents run" className={cx("grid gap-2", !compact && "sm:grid-cols-3")}>
        {RUNNER_CHOICES.map((c) => {
          const on = current === c.runner
          return (
            <button
              key={c.runner}
              type="button"
              aria-pressed={on}
              data-runner-choice={c.runner}
              onClick={() => !on && setChoice(c.runner)}
              className={cx(
                "flex min-h-11 items-start gap-3 rounded-lg border p-3 text-left transition",
                on ? "border-yard-500/60 bg-yard-500/10" : "border-zinc-800 bg-zinc-900 hover:border-zinc-700",
              )}
            >
              <LineIcon icon={c.icon} className={cx("h-4 w-4", on ? "text-yard-300" : "text-zinc-400")} />
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="flex items-center gap-1.5 text-sm font-medium text-zinc-100">
                  {c.title}
                  {on && <Check className="h-3.5 w-3.5 text-yard-300" aria-label="chosen" />}
                </span>
                <span className="block text-xs leading-relaxed text-zinc-400">{c.body}</span>
                <span className="block text-[11px] text-zinc-500">{c.needs}</span>
              </span>
            </button>
          )
        })}
      </div>
      {current === "local" && (
        <p role="note" className="flex items-start gap-2 text-xs leading-relaxed text-amber-200/90" data-testid="runner-choice-warning">
          <LineIcon icon={ShieldAlert} className="h-3.5 w-3.5 text-amber-300" />
          <span>{LOCAL_UNSANDBOXED}</span>
        </p>
      )}
      {current === "docker" && (
        <p className="text-xs leading-relaxed text-zinc-500" data-testid="runner-choice-docker">
          A container can't use this computer's own claude login: add a Claude key below (<code className="font-mono">claude setup-token</code> makes one). Limits and the image are in Settings ›
          Docker.
        </p>
      )}
      {changed && <SourceHint changed />}
      {save.error && <ResultLine ok={false} text={save.error.message} />}
    </div>
  )
}

function toolLine(t: LocalTool, s: SetupStatus): { ok: boolean; text: string } {
  const local = s.local!
  if (!t.found) return { ok: false, text: "Not found" }
  const version = t.version ?? "Found"
  if (t.key === "claude") {
    if (s.credentials.claudeOauthToken.state === "set" || s.credentials.anthropicApiKey.state === "set") return { ok: true, text: `${version} · signs in with the token below` }
    if (local.claudeLogin === true) return { ok: true, text: `${version} · signed in` }
    if (local.claudeLogin === false) return { ok: false, text: `${version} · not signed in: run claude, then /login` }
    return { ok: true, text: version }
  }
  if (t.key === "codex") {
    if (s.credentials.codexAuthJson?.state === "set" || s.credentials.codexApiKey?.state === "set") return { ok: true, text: `${version} · signs in with the saved Codex login` }
    if (local.codexLogin === true) return { ok: true, text: `${version} · signed in` }
    if (local.codexLogin === false) return { ok: false, text: `${version} · not signed in: run ${CODEX_LOGIN_COMMAND}` }
    return { ok: true, text: version }
  }
  if (t.key === "gh") return local.ghLogin ? { ok: true, text: `${version} · signed in` } : { ok: false, text: `${version} · not signed in: run gh auth login` }
  return { ok: true, text: version }
}

/** What local agents use on this computer (#120): Node, claude, gh and Chrome, each found or not, with a way to get it. */
export function LocalPrereqs({ status }: { status: SetupStatus }) {
  const check = useCheckLocal()
  const server = useSettings()
  const local = status.local
  return (
    <div className="space-y-2" data-testid="local-prereqs">
      {!local ? (
        <p className="text-xs text-zinc-500">Looking at this computer…</p>
      ) : (
        <ul className="divide-y divide-zinc-800/80 rounded-lg border border-zinc-800 bg-zinc-900/60">
          {local.tools.map((t) => {
            const info = LOCAL_TOOL_INFO[t.key]
            const line = toolLine(t, status)
            // Something optional that's missing is just that: no warning colour.
            const icon = line.ok ? Check : info.required ? X : Minus
            return (
              <li key={t.key} className="flex items-start gap-2.5 px-3 py-2" data-local-tool={t.key} data-found={t.found || undefined}>
                <LineIcon icon={icon} className={cx("h-3.5 w-3.5", line.ok ? "text-emerald-400" : info.required ? "text-amber-300" : "text-zinc-500")} />
                <div className="min-w-0 flex-1 text-xs leading-relaxed">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium text-zinc-200">{info.label}</span>
                    {!info.required && <span className="text-[11px] text-zinc-500">optional</span>}
                    <span className={cx("min-w-0 wrap-anywhere", line.ok ? "text-zinc-400" : info.required ? "text-amber-200" : "text-zinc-500")}>{line.text}</span>
                  </div>
                  <div className="text-zinc-500">
                    {info.help}
                    {!t.found && (
                      <>
                        {" "}
                        <NewTabLink href={info.link.href} className={linkClass}>
                          {info.link.label}
                        </NewTabLink>
                        .
                      </>
                    )}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button type="button" size="sm" variant="ghost" loading={check.isPending} onClick={() => check.mutate()}>
          <RefreshCw className="h-3.5 w-3.5" /> Check again
        </Button>
        <span className="text-xs text-zinc-500">
          Each task works in its own folder in <span className="font-mono">{server.data?.localDir ?? "~/boxyard-workspaces"}</span>.
        </span>
      </div>
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

/** Zen's first-run card: where agents run, then what that needs, in order, then the optional bits. */
export function SetupCard({ status, className }: { status: SetupStatus; className?: string }) {
  const id = useId()
  const owner = useAgentSettings().data?.sources.ownerName
  const set = (k: CredentialKey) => status.credentials[k].state === "set"
  const choice = status.runner.choice
  const local = choice === "local"
  const localReady = Boolean(status.local?.tools.every((t) => t.found || !LOCAL_TOOL_INFO[t.key].required))
  const computerLogin = local && status.local?.claudeLogin === true
  let n = 0
  return (
    <div className={cx("scroll-thin min-h-0 flex-1 overflow-y-auto", className)} data-testid="setup-card">
      <div className="space-y-1.5 pt-8 pb-6 sm:pt-12">
        <h2 className="text-lg font-semibold text-zinc-50">Set up Box Yard</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          {choice === null
            ? "Pick where your agents run, sign in to Claude, and the Coordinator is ready."
            : local
              ? "Agents run on this computer, so there's no Upstash account to set up."
              : choice === "docker"
                ? "Agents run in Docker containers on this computer, so there's no Upstash account to set up."
                : status.boxes.required
                ? "Two keys and the Coordinator is ready."
                : "One key and the Coordinator is ready."}{" "}
          Keys stay on this server: the browser never sees them again.
        </p>
      </div>
      <ol className="space-y-3">
        <Step n={++n} done={choice !== null} title="Where agents run" help="You can change this later in Settings › Credentials. Each project can also pick its own.">
          <RunnerChoice status={status} />
        </Step>
        {local && (
          <Step n={++n} done={localReady} title="This computer" help="What local agents use here. Install anything missing, then check again.">
            <LocalPrereqs status={status} />
          </Step>
        )}
        {choice === "box" && status.boxes.required && (
          <Step n={++n} done={set("upstashBoxApiKey")} title={CREDENTIAL_INFO.upstashBoxApiKey.label} help={<CredentialHelp k="upstashBoxApiKey" />}>
            <CredentialField k="upstashBoxApiKey" status={status.credentials.upstashBoxApiKey} id={`${id}-box`} />
          </Step>
        )}
        <Step
          n={++n}
          done={status.claude.state === "set"}
          title="Claude"
          tag={computerLogin ? "Optional" : undefined}
          help={computerLogin ? "Signed in with this computer's claude login. A token here is only needed to use a different account." : undefined}
        >
          <ClaudeChoice status={status} id={`${id}-claude`} />
        </Step>
        {status.codex?.required && (
          <Step
            n={++n}
            done={status.codex.state === "set"}
            title="Codex"
            help={status.local?.codexLogin === true ? "Signed in with this computer's codex login. A login here is only needed to use a different account." : "The Coordinator runs on Codex (Settings › Coordinator), so it needs a Codex login."}
          >
            <CodexChoice status={status} id={`${id}-codex`} />
          </Step>
        )}
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
          <Row
            id={fid("runner")}
            label="Where agents run"
            help="Where new projects run. Projects you already have stay where they are; change one in its Settings › Runs on."
          >
            <RunnerChoice status={s} compact />
          </Row>
          {s.runner.choice === "local" && (
            <Row id={fid("local")} label="This computer" help="What local agents use on the computer running Box Yard.">
              <LocalPrereqs status={s} />
            </Row>
          )}
          {(["upstashBoxApiKey", "claudeOauthToken", "anthropicApiKey", "githubToken"] as const).map((k) => (
            <Row
              key={k}
              id={fid(`cred-${k}`)}
              label={CREDENTIAL_INFO[k].label}
              help={
                k === "upstashBoxApiKey" && (s.runner.choice === "local" || s.runner.choice === "docker") ? (
                  <>
                    Optional while agents run on this computer. Add one later to let projects run in isolated Upstash boxes. <CredentialHelp k={k} />
                  </>
                ) : (
                  <CredentialHelp k={k} />
                )
              }
            >
              <CredentialField k={k} status={s.credentials[k]} id={fid(`cred-${k}`)} />
              {k === "upstashBoxApiKey" && (s.runner.choice === "local" || s.runner.choice === "docker") && s.credentials.upstashBoxApiKey.state === "set" && (
                <p className="text-xs leading-relaxed text-zinc-500" data-testid="upstash-ready">
                  Upstash boxes are ready: pick Upstash box in a project's Settings › Runs on, or make it the default above.
                </p>
              )}
            </Row>
          ))}
          {s.credentials.claudeOauthToken.state === "set" && s.credentials.anthropicApiKey.state === "set" && (
            <p className="mt-2 text-xs text-zinc-500">Both Claude credentials are set, so Claude Code uses the API key.</p>
          )}
          <h4 className="mt-6 border-t border-zinc-900 pt-5 text-sm font-semibold text-zinc-100">Codex</h4>
          <p className="mt-1 mb-4 text-xs leading-relaxed text-zinc-500" data-testid="codex-credentials-intro">
            {s.codex?.required
              ? "The Coordinator runs on Codex, so it needs one of these."
              : "Only for agents set to run on Codex: the Coordinator, the Captains or a project's agents."}{" "}
            {s.local?.codexLogin === true && "Agents on this computer can use its codex login; boxes and containers need one of these."}
          </p>
          {(["codexAuthJson", "codexApiKey"] as const).map((k) => (
            <Row key={k} id={fid(`cred-${k}`)} label={CREDENTIAL_INFO[k].label} help={<CredentialHelp k={k} />}>
              <CredentialField k={k} status={s.credentials[k] ?? UNSET} id={fid(`cred-${k}`)} />
            </Row>
          ))}
          {s.credentials.codexAuthJson?.state === "set" && s.credentials.codexApiKey?.state === "set" && (
            <p className="mt-2 text-xs text-zinc-500" data-testid="codex-both">
              {CODEX_BOTH}
            </p>
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
