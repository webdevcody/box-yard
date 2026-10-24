import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { providerOf, q, type BoxProvider } from "./providers/types.js"
import { errorMessage } from "./util/retry.js"

/**
 * Upstash Box refuses one uploaded file over 100 MB ("file exceeds maximum size of 100 MB"; the docs: "Each file can
 * be up to 100 MB"). Counted in decimal MB, the smaller reading.
 */
export const UPSTASH_MAX_UPLOAD_BYTES = 100 * 1000 * 1000
/** The largest part putFile sends, whatever the limit: about 90 MB. */
const PART_MAX_BYTES = 90 * 1000 * 1000

/** The part size for a provider's per-file limit: 90% of it, at most PART_MAX_BYTES. */
export const uploadPartBytes = (limit: number) => Math.max(1, Math.min(PART_MAX_BYTES, Math.floor(limit * 0.9)))

/** Did the provider refuse an upload for its size? */
export function isUploadTooBig(err: unknown): boolean {
  const status = (err as { statusCode?: number; status?: number })?.statusCode ?? (err as { status?: number })?.status
  return status === 413 || /exceeds (the )?maximum (file )?size|payload too large|request entity too large/i.test(errorMessage(err))
}

/** Bash: the size of a file in bytes, 0 when it's missing (`wc -c` pads it with spaces on macOS). */
const SIZE_FN = `bysz() { if [ -f "$1" ]; then wc -c < "$1" | tr -d ' '; else echo 0; fi; }`

/**
 * Put a file from this machine on a box. A file over the provider's per-file upload limit (`maxUploadBytes`) goes up in
 * parts and is joined on the box: each part is uploaded next to the destination, appended to `<destination>.boxyard-join`
 * and deleted, so the box needs room for the file plus one part, and so does this machine. Each append checks the join's
 * size first, so an exec that runs twice doesn't append twice; the whole file is moved into place only when its size is
 * right. A failure leaves neither the join nor a part behind. Returns how many uploads it took.
 */
export async function putFile(p: BoxProvider, boxId: string, localPath: string, destination: string): Promise<{ parts: number }> {
  const size = fs.statSync(localPath).size
  const limit = providerOf(p, boxId).maxUploadBytes
  const part = limit ? uploadPartBytes(limit) : Infinity
  if (size <= part) {
    await p.uploadFile(boxId, localPath, destination)
    return { parts: 1 }
  }
  const join = `${destination}.boxyard-join`
  const piece = `${destination}.boxyard-part`
  const parts = Math.ceil(size / part)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "boxyard-upload-"))
  const local = path.join(tmp, "part")
  const fd = fs.openSync(localPath, "r")
  try {
    const prep = await p.exec(boxId, `mkdir -p ${q(path.posix.dirname(destination))} && rm -f ${q(join)} ${q(piece)}`)
    if (prep.exitCode !== 0) throw new Error(`couldn't prepare ${destination}: ${(prep.stderr || prep.stdout).trim().slice(-300)}`)
    const buf = Buffer.allocUnsafe(part)
    for (let i = 0, offset = 0; offset < size; i++, offset += part) {
      const want = Math.min(part, size - offset)
      let got = 0
      while (got < want) {
        const n = fs.readSync(fd, buf, got, want - got, offset + got)
        if (n === 0) throw new Error(`${localPath} got shorter while it was uploaded`)
        got += n
      }
      fs.writeFileSync(local, buf.subarray(0, want))
      await p.uploadFile(boxId, local, piece)
      const end = offset + want
      const res = await p.exec(
        boxId,
        `${SIZE_FN}; [ "$(bysz ${q(join)})" = ${offset} ] && cat ${q(piece)} >> ${q(join)}; rm -f ${q(piece)}; [ "$(bysz ${q(join)})" = ${end} ]`,
      )
      if (res.exitCode !== 0) throw new Error(`joining part ${i + 1} of ${parts} of ${destination} on the box failed${res.stderr.trim() ? `: ${res.stderr.trim().slice(-300)}` : ""}`)
    }
    const done = await p.exec(boxId, `${SIZE_FN}; [ "$(bysz ${q(join)})" = ${size} ] && mv -f ${q(join)} ${q(destination)}`)
    if (done.exitCode !== 0) throw new Error(`${destination} came out the wrong size on the box after joining ${parts} parts`)
    return { parts }
  } catch (err) {
    await p.exec(boxId, `rm -f ${q(join)} ${q(piece)}`).catch(() => {})
    throw err
  } finally {
    fs.closeSync(fd)
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
