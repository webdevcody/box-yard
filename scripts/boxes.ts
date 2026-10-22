/**
 * List or delete Upstash boxes on this account (uses UPSTASH_BOX_API_KEY from .env).
 *
 *   npx tsx scripts/boxes.ts                 # list boxes
 *   npx tsx scripts/boxes.ts rm <id> [id...] # delete boxes
 *   npx tsx scripts/boxes.ts rm --label boxyard-smoke   # delete every box with a label
 */
import { Box } from "@upstash/box"
import { config } from "../server/config.js"

const apiKey = config.upstashBoxApiKey
if (!apiKey) throw new Error("UPSTASH_BOX_API_KEY is not set")
const [cmd, ...rest] = process.argv.slice(2)

async function main() {
  if (cmd === "rm") {
    let ids = rest
    if (rest[0] === "--label") {
      ids = (await Box.list({ apiKey, label: rest[1] })).filter((b) => b.status !== "deleted").map((b) => b.id)
    }
    if (!ids.length) return console.log("nothing to delete")
    await Box.delete({ apiKey, boxIds: ids })
    return console.log(`deleted ${ids.join(", ")}`)
  }
  const boxes = await Box.list({ apiKey })
  for (const b of boxes) {
    const x = b as unknown as { id: string; name?: string; status: string; labels?: string[]; created_at?: number; keep_alive?: boolean }
    console.log([x.id, x.status, x.name ?? "", (x.labels ?? []).join(","), x.keep_alive ? "keep-alive" : ""].filter(Boolean).join("  "))
  }
  if (!boxes.length) console.log("no boxes")
}

await main()
