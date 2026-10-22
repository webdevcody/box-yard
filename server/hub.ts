import type { Response } from "express"
import type { UiEvent } from "../shared/types.js"

/** Fans server events out to every open browser tab over SSE. */
export class Hub {
  private clients = new Set<Response>()
  private heartbeat: NodeJS.Timeout

  constructor() {
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) res.write(": ping\n\n")
    }, 25_000)
    this.heartbeat.unref()
  }

  attach(res: Response) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })
    res.write("retry: 2000\n\n")
    this.clients.add(res)
    res.on("close", () => this.clients.delete(res))
  }

  broadcast(event: UiEvent) {
    const data = `data: ${JSON.stringify(event)}\n\n`
    for (const res of this.clients) {
      try {
        res.write(data)
      } catch {
        this.clients.delete(res)
      }
    }
  }

  close() {
    clearInterval(this.heartbeat)
    for (const res of this.clients) res.end()
    this.clients.clear()
  }
}
