import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { GENERATED_PASSWORD_LENGTH, generatePassword, MIN_PASSWORD_LENGTH, passwordLength, passwordProblems, passwordRefusal } from "../server/password.js"
import { checkPassword, envPassword, withEnvPassword, writePassword, type Io } from "../scripts/password.js"
import { tmpDir } from "./helpers.js"

const ctx = { usernames: ["cody"] }
const problems = (pw: string) => passwordProblems(pw, ctx)

describe("BOXYARD_PASSWORD rules", () => {
  it.each([
    ["too short", "Xq7#mv!Lp2&Rz9", /14 characters long; it needs at least 15/],
    ["on the common list", "1qaz2wsx3edc4rfv", /list of common and leaked passwords/],
    ["a common one in another case", "QAZWSXEDCRFVTGB", /list of common and leaked passwords/],
    ["a common one padded", "!!!!football2024!!!!", /common or leaked password with a few characters changed or added/],
    ["a common one in 1337 with spaces", "!!! I L0v3 Y0u !!!!!!", /common or leaked password/],
    ["one repeated character", "zzzzzzzzzzzzzzzzzzzz", /one character repeated/],
    ["a repeated pattern", "tuvtuvtuvtuvtuvtuvtuv", /same 3 characters repeated/],
    ["an ascending sequence", "abcdefghijklmnopq", /simple sequence/],
    ["a descending sequence with digits wrapping", "32109876543210987", /simple sequence/],
    ["a keyboard run", "ghjkl;'zxcvbnm,./", /simple sequence/],
    ["containing password", "my long password for the yard", /contains "password"/],
    ["containing password in 1337", "the P@ssW0rd is plum orbit", /contains "password"/],
    ["containing boxyard", "welcome to my BoxYard, friend", /contains "boxyard"/],
    ["containing boxyard with a dash", "it's the box-yard key, mate", /contains "boxyard"/],
    ["containing the username", "plum orbit Cody velvet tuesday", /username Box Yard runs as \(cody\)/],
  ])("refuses a password %s", (_name, pw, reason) => {
    const found = problems(pw)
    expect(found.join("\n")).toMatch(reason)
  })

  it("accepts strong passwords, with no composition rules and no upper limit", () => {
    for (const pw of [
      "plum orbit velvet tuesday",
      "lantern-gravel-quokka-sonnet",
      "ilikewalkingmydogbythecanal",
      "Ünïcödé pässphrâse öne",
      "7Hq2LwZ9vB4nR8kT1mYc",
      "a long passphrase made of plain lowercase words and nothing else at all, sixty four+",
      "🐙🦊🐳🌵🍕🚀🎲🧩🪁🛶🌋🦉🍄🎻🧭",
    ]) {
      expect(problems(pw), pw).toEqual([])
    }
    const long = Array.from({ length: 50 }, (_, i) => `word${i * 7919}`).join(" ")
    expect(passwordLength(long)).toBeGreaterThan(64)
    expect(problems(long)).toEqual([])
  })

  it("counts characters as Unicode code points", () => {
    const fourteen = "🐙🦊🐳🌵🍕🚀🎲🧩🪁🛶🌋🦉🍄🎻"
    expect(fourteen.length).toBe(28)
    expect(passwordLength(fourteen)).toBe(14)
    expect(problems(fourteen).join()).toMatch(/14 characters long/)
    expect(problems(`${fourteen}🧭`)).toEqual([])
  })

  it("only refuses usernames of 3+ characters, and checks every one given", () => {
    expect(passwordProblems("plum orbit al velvet tuesday", { usernames: ["al"] })).toEqual([])
    expect(passwordProblems("plum orbit rootbeer tuesday", { usernames: ["cody", "root"] }).join()).toMatch(/\(root\)/)
  })

  it("explains the refusal and suggests a strong password and the generator, without echoing the weak one", () => {
    const weak = "hunter2hunter2"
    const text = passwordRefusal(problems(weak), ctx)
    expect(text).toMatch(/14 characters long/)
    expect(text).toContain("./yard password")
    expect(text).not.toContain(weak)
    const suggested = /freshly made for you: (\S+)/.exec(text)?.[1]
    expect(suggested).toBeTruthy()
    expect(problems(suggested!)).toEqual([])
    expect(text).toMatch(/no override/i)
  })
})

describe("the password generator", () => {
  it("makes 24+ URL-safe random characters that pass the rules", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const pw = generatePassword(ctx)
      expect(pw.length).toBeGreaterThanOrEqual(24)
      expect(pw).toHaveLength(GENERATED_PASSWORD_LENGTH)
      expect(pw).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(problems(pw)).toEqual([])
      seen.add(pw)
    }
    expect(seen.size).toBe(200)
    expect(GENERATED_PASSWORD_LENGTH).toBeGreaterThan(MIN_PASSWORD_LENGTH)
  })
})

function io(answer = false) {
  const out: string[] = []
  const err: string[] = []
  const asked: string[] = []
  const value: Io = {
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
    confirm: async (q) => {
      asked.push(q)
      return answer
    },
  }
  return { io: value, out, err, asked }
}

describe("./yard password", () => {
  it("reads and writes BOXYARD_PASSWORD like the server reads .env", () => {
    expect(envPassword("# BOXYARD_PASSWORD=old\nBOXYARD_PASSWORD=\"q x\"\nBOXYARD_PASSWORD=second\n")).toBe("q x")
    expect(envPassword("BOXYARD_PASSWORD=\n")).toBe("")
    expect(envPassword("PORT=3000\n")).toBe("")
    expect(withEnvPassword("A=1\n# BOXYARD_PASSWORD=x\nBOXYARD_PASSWORD=old\nB=2\n", "new")).toBe("A=1\n# BOXYARD_PASSWORD=x\nBOXYARD_PASSWORD=new\nB=2\n")
    expect(withEnvPassword("A=1", "new")).toBe("A=1\nBOXYARD_PASSWORD=new\n")
    expect(withEnvPassword("", "new")).toBe("BOXYARD_PASSWORD=new\n")
  })

  it("creates .env from .env.example with a password that passes, and prints it once", async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, ".env.example"), "PORT=3000\nBOXYARD_PASSWORD=\nHOST=\n")
    const t = io()
    const envFile = path.join(dir, ".env")
    expect(await writePassword({ envFile, exampleFile: path.join(dir, ".env.example"), io: t.io, ...ctx })).toBe(0)
    const text = fs.readFileSync(envFile, "utf8")
    const pw = envPassword(text)
    expect(pw).toHaveLength(GENERATED_PASSWORD_LENGTH)
    expect(problems(pw)).toEqual([])
    expect(text).toBe(`PORT=3000\nBOXYARD_PASSWORD=${pw}\nHOST=\n`)
    expect(t.asked).toEqual([])
    expect(t.out.join("\n").split(pw)).toHaveLength(2)
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600)
  })

  it("asks before replacing an existing password, and keeps it on no", async () => {
    const dir = tmpDir()
    const envFile = path.join(dir, ".env")
    const before = "BOXYARD_PASSWORD=plum orbit velvet tuesday\nPORT=3000\n"
    fs.writeFileSync(envFile, before)

    const no = io(false)
    expect(await writePassword({ envFile, io: no.io, ...ctx })).toBe(1)
    expect(no.asked).toHaveLength(1)
    expect(no.asked[0]).toMatch(/already has a BOXYARD_PASSWORD\. Replace it\?/)
    expect(fs.readFileSync(envFile, "utf8")).toBe(before)
    expect(no.out).toEqual([])

    const yes = io(true)
    expect(await writePassword({ envFile, io: yes.io, ...ctx })).toBe(0)
    expect(yes.asked).toHaveLength(1)
    const replaced = envPassword(fs.readFileSync(envFile, "utf8"))
    expect(replaced).not.toBe("plum orbit velvet tuesday")
    expect(problems(replaced)).toEqual([])

    const forced = io(false)
    expect(await writePassword({ envFile, yes: true, io: forced.io, ...ctx })).toBe(0)
    expect(forced.asked).toEqual([])
    expect(envPassword(fs.readFileSync(envFile, "utf8"))).not.toBe(replaced)
  })

  it("checks the password in .env without printing it", () => {
    const dir = tmpDir()
    const envFile = path.join(dir, ".env")
    const run = (text: string) => {
      fs.writeFileSync(envFile, text)
      const t = io()
      return { code: checkPassword({ envFile, io: t.io, ...ctx }), text: [...t.out, ...t.err].join("\n") }
    }
    const strong = run("BOXYARD_PASSWORD=lantern-gravel-quokka-sonnet\n")
    expect(strong.code).toBe(0)
    expect(strong.text).not.toContain("lantern")
    const weak = run("BOXYARD_PASSWORD=my-password-123\n")
    expect(weak.code).toBe(1)
    expect(weak.text).toMatch(/contains "password"/)
    expect(weak.text).not.toContain("my-password")
    expect(run("BOXYARD_PASSWORD=\n").code).toBe(2)
  })
})
