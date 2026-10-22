export const REVEAL_CHAT_EVENT = "box-yard:reveal-chat"

/** Scroll the orchestrator chat to a message, rendering it first if it's in the older, not yet shown part. */
export function revealChatMessage(id: string) {
  window.dispatchEvent(new CustomEvent(REVEAL_CHAT_EVENT, { detail: id }))
}
