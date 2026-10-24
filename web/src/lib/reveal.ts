export const REVEAL_CHAT_EVENT = "box-yard:reveal-chat"

/** Scroll the orchestrator chat to a message, rendering it first if it's in the older, not yet shown part. */
export function revealChatMessage(id: string) {
  window.dispatchEvent(new CustomEvent(REVEAL_CHAT_EVENT, { detail: id }))
}

export const REVEAL_QUEUE_EVENT = "box-yard:reveal-queue"
/** The task page's Queued rows: /tasks/:id#queue scrolls to them. */
export const QUEUE_HASH = "#queue"

/** Open a task's queued messages: go to its page and scroll to the Queued rows. */
export function revealTaskQueue(taskId: string, navigate: (to: string) => void) {
  navigate(`/tasks/${taskId}${QUEUE_HASH}`)
  // A task page that is already open scrolls on the event; one that mounts reads the hash.
  window.dispatchEvent(new CustomEvent(REVEAL_QUEUE_EVENT, { detail: taskId }))
}
