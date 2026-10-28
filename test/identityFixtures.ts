import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { tmpDir } from "./helpers.js"

// A made-up computer and GitHub for identity detection tests (docs/identities.md › Set up from this computer):
// octocat (gh's active account), octo-acme (a member of acme-corp) and a failed GHE login. Nothing here is real.

export const TOKENS: Record<string, string> = { octocat: "gho_FAKEoctocat0000000000000000000000", "octo-acme": "gho_FAKEoctoacme000000000000000000000" }

export const STATUS = `github.com
  ✓ Logged in to github.com account octocat (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'

  ✓ Logged in to github.com account octo-acme (/home/u/.config/gh/hosts.yml)
  - Active account: false
  - Git operations protocol: ssh
  - Token: ${TOKENS["octo-acme"]}
  - Token scopes: 'repo'

ghe.acme.dev
  X Failed to log in to ghe.acme.dev account acme-admin (keyring)
  - Active account: true
  - The token in keyring is invalid.
  - To re-authenticate, run: gh auth login -h ghe.acme.dev
`

/** A made-up computer: a home folder with git, ssh and repo setup, and a gh that knows two accounts. */
export function computer() {
  const root = tmpDir("detect-home-")
  const home = path.join(root, "home")
  const bin = path.join(root, "bin")
  const log = path.join(root, "gh.log")
  for (const d of [home, bin, path.join(home, ".ssh"), path.join(home, "work", "acme", "app", ".git"), path.join(home, "work", "acme", "tools", "cli", ".git")]) fs.mkdirSync(d, { recursive: true })
  const key = (name: string, passphrase = "") => {
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", passphrase, "-C", name, "-f", path.join(home, ".ssh", name)])
    return fs.readFileSync(path.join(home, ".ssh", `${name}.pub`), "utf8").trim().split(" ").slice(0, 2).join(" ")
  }
  const keys = { login: key("id_ed25519"), acme: key("acme"), signing: key("acme_signing"), locked: key("locked", "a passphrase") }
  fs.writeFileSync(path.join(home, ".gitconfig"), `[user]\n\tname = Octo Cat\n\temail = octocat@example.com\n[credential]\n\thelper = osxkeychain\n[credential "https://example.com"]\n\thelper = "!f() { echo password=hunter2; }; f"\n[includeIf "gitdir:~/work/acme/"]\n\tpath = ~/.gitconfig-acme\n[includeIf "gitdir:~/gone/"]\n\tpath = missing.inc\n`)
  fs.writeFileSync(path.join(home, ".gitconfig-acme"), `[user]\n\tname = Acme Octo\n\temail = octo@acme.dev\n\tsigningKey = ~/.ssh/acme_signing\n[gpg]\n\tformat = ssh\n[commit]\n\tgpgSign = true\n[core]\n\tsshCommand = ssh -i ~/.ssh/acme -o IdentitiesOnly=yes\n`)
  fs.writeFileSync(path.join(home, "work", "acme", "app", ".git", "config"), `[remote "origin"]\n\turl = git@github-acme:acme-corp/app.git\n`)
  fs.writeFileSync(path.join(home, "work", "acme", "tools", "cli", ".git", "config"), `[remote "origin"]\n\turl = https://github.com/acme-corp/cli\n`)
  fs.writeFileSync(path.join(home, ".ssh", "config"), `Host github-acme\n  HostName github.com\n  IdentityFile ~/.ssh/acme\n`)
  // gh's status goes to stderr when an account fails, as the real one does; the env check proves GH_TOKEN never reaches it.
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh
[ -n "$GH_TOKEN$GITHUB_TOKEN" ] && echo "env token seen" >> ${JSON.stringify(log)}
echo "$@" >> ${JSON.stringify(log)}
if [ "$1 $2" = "auth status" ]; then cat <<'EOT' >&2
${STATUS}EOT
exit 1; fi
if [ "$1 $2" = "auth token" ]; then
  case "$*" in *"--user octocat"*) echo ${TOKENS.octocat};; *"--user octo-acme"*) echo ${TOKENS["octo-acme"]};; *) echo "no oauth token found" >&2; exit 1;; esac
  exit 0; fi
exit 1
`,
    { mode: 0o755 },
  )
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "env-token-must-not-reach-gh", GITHUB_TOKEN: "env-token-must-not-reach-gh" }
  return { home, env, log, keys }
}

/** GitHub for the two made-up accounts. */
export function github(keys: ReturnType<typeof computer>["keys"]) {
  const who: Record<string, { login: string; id: number }> = { [TOKENS.octocat!]: { login: "octocat", id: 1 }, [TOKENS["octo-acme"]!]: { login: "octo-acme", id: 101 } }
  const calls: string[] = []
  const f = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const account = who[(new Headers(init?.headers).get("Authorization") ?? "").replace(/^Bearer /, "")]
    calls.push(`${account?.login ?? "?"} ${url.pathname}`)
    if (!account) return new Response("{}", { status: 401 })
    const acme = account.login === "octo-acme"
    const route: Record<string, unknown> = {
      "/user": { login: account.login, id: account.id, name: null },
      "/user/orgs": acme ? [{ login: "acme-corp" }] : [],
      "/user/emails": [{ email: acme ? "octo@acme.dev" : "octocat@example.com", verified: true }],
      "/users/octo-acme/ssh_signing_keys": [{ key: keys.signing }],
      "/users/octo-acme/keys": [{ key: keys.acme }],
      "/users/octocat/ssh_signing_keys": [],
      "/users/octocat/keys": [{ key: keys.login }],
    }
    if (url.pathname in route) return Response.json(route[url.pathname], { headers: { "x-oauth-scopes": "repo, read:org" } })
    if (url.pathname === "/repos/acme-corp/app" && acme) return Response.json({ permissions: { push: true } })
    if (url.pathname === "/repos/octocat/site" && !acme) return Response.json({ permissions: { push: true } })
    if (url.pathname === "/repos/octocat/site" && acme) return Response.json({ permissions: { push: false } })
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
  }
  return { fetch: f as typeof fetch, calls }
}
