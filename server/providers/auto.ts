import type { WorkerSize } from "../../shared/types.js"
import type { BoxHealth, BoxProvider, BoxSnapshotInfo, BoxUsageProbe, ExecResult } from "./types.js"

/** Local boxes are folders named local-<id> (LocalProvider.create); every other id is an Upstash box. */
export const isLocalBox = (boxId: string) => boxId.startsWith("local-")

/**
 * The provider when BOX_PROVIDER isn't set and the env has no UPSTASH_BOX_API_KEY: new boxes are Upstash boxes
 * once a key is saved in Settings › Credentials, and folders on this machine until then, with no restart. Every
 * box keeps going to the provider that made it, so saving or removing the key never strands a box.
 */
export class AutoProvider implements BoxProvider {
  constructor(
    private readonly local: BoxProvider,
    private readonly upstash: BoxProvider,
    private readonly useUpstash: () => boolean,
  ) {}

  /** Where new boxes come from right now. */
  private get active(): BoxProvider {
    return this.useUpstash() ? this.upstash : this.local
  }

  of(boxId: string): BoxProvider {
    return isLocalBox(boxId) ? this.local : this.upstash
  }

  get name() {
    return this.active.name
  }
  get nodeBin() {
    return this.active.nodeBin
  }
  get claudeBin() {
    return this.active.claudeBin
  }
  get codexBin() {
    return this.active.codexBin
  }

  root(boxId: string) {
    return this.of(boxId).root(boxId)
  }
  create(opts: { labels: string[]; size?: WorkerSize; snapshotId?: string }) {
    return this.active.create(opts)
  }
  /** A snapshot goes to the provider of its box; local snapshot ids start with local- like local box ids. */
  snapshot(boxId: string, name: string): Promise<BoxSnapshotInfo> {
    const p = this.of(boxId)
    if (!p.snapshot) throw new Error(`${p.name} boxes can't be snapshotted`)
    return p.snapshot(boxId, name)
  }
  async deleteSnapshot(snapshotId: string): Promise<void> {
    const p = isLocalBox(snapshotId) ? this.local : this.upstash
    if (p.deleteSnapshot) await p.deleteSnapshot(snapshotId)
  }
  snapshotDirs(boxId: string) {
    return this.of(boxId).snapshotDirs?.(boxId) ?? { home: "$HOME", tmp: "/tmp" }
  }
  health(boxId: string): Promise<BoxHealth> {
    return this.of(boxId).health(boxId)
  }
  wake(boxId: string) {
    return this.of(boxId).wake(boxId)
  }
  exec(boxId: string, command: string): Promise<ExecResult> {
    return this.of(boxId).exec(boxId, command)
  }
  execStream(boxId: string, command: string, onOutput: (chunk: string) => void) {
    return this.of(boxId).execStream(boxId, command, onOutput)
  }
  hold(boxId: string, command: string, signal: AbortSignal) {
    return this.of(boxId).hold(boxId, command, signal)
  }
  writeFile(boxId: string, filePath: string, content: string | Buffer) {
    return this.of(boxId).writeFile(boxId, filePath, content)
  }
  readFile(boxId: string, filePath: string) {
    return this.of(boxId).readFile(boxId, filePath)
  }
  uploadFile(boxId: string, localPath: string, destination: string) {
    return this.of(boxId).uploadFile(boxId, localPath, destination)
  }
  publicUrl(boxId: string, port: number) {
    return this.of(boxId).publicUrl(boxId, port)
  }
  destroy(boxId: string) {
    return this.of(boxId).destroy(boxId)
  }
  /** Leftover boxes are only looked for on Upstash, and only once there's a key to look with. */
  async listIds(label: string): Promise<string[]> {
    return this.useUpstash() && this.upstash.listIds ? this.upstash.listIds(label) : []
  }
  async usage(boxId: string): Promise<BoxUsageProbe> {
    const p = this.of(boxId)
    return p.usage ? p.usage(boxId) : { source: "estimated" }
  }
}
