// A stand-in for OpenAI's Realtime API (wss://…/v1/realtime): point OPENAI_BASE_URL (or TtsService's
// baseUrls.openai) at `baseUrl`. Each connection is recorded with its URL, headers and client events;
// `behave` answers each response.create, `reject` refuses the handshake the way OpenAI does.
import http, { type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import { WebSocketServer, type WebSocket } from "ws"

export interface RealtimeSession {
  url: string
  headers: IncomingHttpHeaders
  events: any[]
  closed: boolean
}

export type Send = (ev: object) => void
export type Behave = (s: RealtimeSession, send: Send, ws: WebSocket) => void | Promise<void>

const b64 = (s: string) => Buffer.from(s).toString("base64")

/** Answer with these audio deltas (as text, base64-encoded on the wire), then response.done. */
export const speak =
  (chunks: string[], opts: { before?: (i: number) => Promise<void> | void } = {}): Behave =>
  async (_s, send) => {
    for (let i = 0; i < chunks.length; i++) {
      await opts.before?.(i)
      send({ type: "response.output_audio.delta", response_id: "resp_1", item_id: "item_1", output_index: 0, content_index: 0, delta: b64(chunks[i]!) })
    }
    send({ type: "response.output_audio.done", response_id: "resp_1" })
    send({ type: "response.done", response: { id: "resp_1", status: "completed", output: [] } })
  }

export async function fakeRealtime(behave: Behave = speak(["PCM-", "AUDIO"]), reject?: (s: RealtimeSession) => { status: number; body: object } | null) {
  const server = http.createServer()
  const wss = new WebSocketServer({ noServer: true })
  const sessions: RealtimeSession[] = []
  const sockets = new Set<WebSocket>()
  server.on("upgrade", (req, socket, head) => {
    const s: RealtimeSession = { url: req.url ?? "", headers: req.headers, events: [], closed: false }
    sessions.push(s)
    const no = reject?.(s)
    if (no) {
      const body = JSON.stringify(no.body)
      socket.end(`HTTP/1.1 ${no.status} Refused\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws)
      const send: Send = (ev) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(ev))
      send({ type: "session.created", event_id: "ev_1", session: { type: "realtime", model: new URL(s.url, "http://x").searchParams.get("model") } })
      ws.on("message", (data) => {
        const ev = JSON.parse(data.toString())
        s.events.push(ev)
        if (ev.type === "response.create") void behave(s, send, ws)
      })
      ws.on("close", () => {
        s.closed = true
        sockets.delete(ws)
      })
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    sessions,
    close: () =>
      new Promise<void>((r) => {
        for (const ws of sockets) ws.terminate()
        wss.close()
        server.close(() => r())
      }),
  }
}

/** A promise you resolve from outside: holds a fake's next step until the test says so. */
export function gate() {
  let open!: () => void
  const wait = new Promise<void>((r) => (open = r))
  return { wait, open }
}
