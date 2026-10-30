// How the chats Box Yard runs on this server (the Coordinator, each Captain, side threads) start their agent CLI:
// Claude Code as before, or Codex (docs/codex.md). A Codex launch translates its output into Claude Code's
// stream-json messages (server/codex.ts CodexStream), so each chat reads one kind of message whichever CLI it runs on.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Config } from "./config.js"
import type { CredentialStore } from "./credentials.js"
import type { Attachment, Effort } from "../shared/types.js"
import { codexContext, codexExecArgs, CodexStream, seedCodexAuth } from "./codex.js"
import { withOwner } from "../shared/owner.js"
import type { AgentCli } from "../shared/agentCli.js"

/** The env var a Codex chat reads its Box Yard MCP token from (codex's bearer_token_env_var). */
export const MCP_TOKEN_ENV = "BOXYARD_MCP_TOKEN"

/** Env vars that would log `codex` in some way other than the one Box Yard hands it. */
const CODEX_LOGIN_VARS = ["CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"]

/** Everything one run of a chat's CLI needs. */
export interface ChatLaunch {
  cli: AgentCli
  bin: string
  args: string[]
  env: NodeJS.ProcessEnv
  /** Codex: turns one line of its output into stream-json messages. Claude Code: null, each line is one already. */
  translate: ((line: string) => any[]) | null
  /** Called once the process has ended (Codex: take back a login file it refreshed). */
  after(): void
}

/**
 * Where the server's Codex chats keep their sessions and login: `<data>/codex` when Box Yard hands Codex a login
 * (Settings › Credentials), else this computer's own Codex home and `codex login`.
 */
export function serverCodexHome(c: Pick<Config, "dataDir" | "mock" | "codexBin">, credentials: Pick<CredentialStore, "codexLogin">): { home: string; own: boolean } {
  // A stand-in codex (mock mode, tests) never touches this computer's real Codex home either.
  if (credentials.codexLogin() || c.mock || /fake-codex/.test(c.codexBin)) return { home: path.join(c.dataDir, "codex"), own: true }
  return { home: process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"), own: false }
}

/** This computer's own `codex login` is there (a login file in its Codex home). */
export function hasOwnCodexLogin(): boolean {
  return fs.existsSync(path.join(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"), "auth.json"))
}

/** A Codex run for a chat on this server: a manager (no shell), Box Yard's HTTP tools, the login in effect. */
export function codexChatLaunch(opts: {
  c: Pick<Config, "codexBin" | "dataDir" | "mock">
  credentials: Pick<CredentialStore, "codexLogin" | "adoptCodexAuth">
  mcp: { url: string; token: string }
  /** The thread to resume, or null for a new one. */
  resume: string | null
  model: string | null
  effort: Effort | null
  instructions: string
  images?: string[]
  /** Side threads only look things up; the chats search the web like Claude Code's WebSearch. */
  webSearch?: boolean
}): ChatLaunch {
  const login = opts.credentials.codexLogin()
  const { home, own } = serverCodexHome(opts.c, opts.credentials)
  const env: NodeJS.ProcessEnv = { ...process.env, [MCP_TOKEN_ENV]: opts.mcp.token }
  for (const k of Object.keys(env)) if (k === "CLAUDECODE" || /^CLAUDE_CODE_(SESSION|CHILD|ENTRYPOINT|MESSAGING)/.test(k)) delete env[k]
  delete env.BOXYARD_SECRET_KEY
  if (own) {
    for (const k of CODEX_LOGIN_VARS) delete env[k]
    env.CODEX_HOME = home
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    if (!login) {
      // Mock mode with no login set: nothing to hand over.
    } else if (login.kind === "chatgpt") seedCodexAuth(home, login.auth)
    else {
      // An API key: a login file left from an earlier ChatGPT login would win over it.
      fs.rmSync(path.join(home, "auth.json"), { force: true })
      env.CODEX_API_KEY = login.key
    }
  } else {
    // This computer's own `codex login`; the TTS key isn't a Codex login.
    delete env.OPENAI_API_KEY
  }
  const [bin, ...pre] = opts.c.codexBin.split(" ")
  const stream = new CodexStream({ model: opts.model, context: (id) => codexContext(home, id) })
  return {
    cli: "codex",
    bin: bin!,
    args: [
      ...pre,
      ...codexExecArgs({
        resume: opts.resume,
        model: opts.model,
        effort: opts.effort,
        instructions: opts.instructions,
        mcp: { url: opts.mcp.url, tokenEnv: MCP_TOKEN_ENV },
        manager: true,
        webSearch: opts.webSearch,
        images: opts.images,
      }),
    ],
    env,
    translate: (line) => stream.push(line),
    after() {
      // Codex refreshes the ChatGPT tokens when they're a week old: keep the new ones for every later run.
      if (login?.kind !== "chatgpt" || !own) return
      try {
        opts.credentials.adoptCodexAuth(fs.readFileSync(path.join(home, "auth.json"), "utf8"))
      } catch {}
    },
  }
}

/** Box Yard's note for a chat that runs on Codex, after its system prompt: what differs from Claude Code. */
export function codexManagerNote(ownerName: string): string {
  return withOwner(
    [
      "You run on Codex, not Claude Code. Box Yard's tools are your `boxyard` MCP tools; call them the same way the prompt above describes.",
      "You have no shell and no file tools here: where the prompt above says to use the Read tool, use Box Yard's tools instead (read_compaction for compaction logs). Images Cody attaches come attached to the message, and small text files come inline; pass any other attachment to an agent by its id.",
    ].join(" "),
    ownerName,
  )
}

const TEXT_MIME = /^(text\/|application\/(json|xml|yaml|x-yaml|toml|javascript|typescript|x-sh))/
/** A text attachment up to this size goes into a Codex chat's prompt as it is. */
const INLINE_MAX_BYTES = 50_000

/** The attached images among `files`, by path (Codex `--image`). */
export function attachedImages(files: unknown): string[] {
  if (!Array.isArray(files)) return []
  return (files as Attachment[]).filter((f) => f.mime?.startsWith("image/") && f.path && fs.existsSync(f.path)).map((f) => f.path!)
}

/** What a Codex chat is told about attached files: images are attached, small text files inline, the rest by id. */
export function codexAttachmentNote(files: unknown, ownerName?: string): string {
  if (!Array.isArray(files) || !files.length) return ""
  const lines: string[] = []
  for (const f of files as Attachment[]) {
    const head = `- ${f.name} (${f.mime}, ${f.size} bytes) id=${f.id}`
    if (f.mime?.startsWith("image/")) lines.push(`${head}: attached to this message`)
    else if (f.path && TEXT_MIME.test(f.mime ?? "") && f.size <= INLINE_MAX_BYTES) {
      let text: string | null = null
      try {
        text = fs.readFileSync(f.path, "utf8")
      } catch {}
      lines.push(text === null ? `${head}: no longer on the server` : `${head}:\n\`\`\`\n${text}\n\`\`\``)
    } else lines.push(`${head}: can't be opened here`)
  }
  return `\n\n[${withOwner("Cody", ownerName)} attached ${files.length === 1 ? "a file" : "files"}. To give them to an agent, pass the ids in the \`attachments\` param of create_task, create_tasks or send_to_task.]\n${lines.join("\n")}`
}
