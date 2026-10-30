// A reply typed in a task's card goes straight to that task (CardComposer). When the server refuses it (the task
// can't take a message at all; a gone box is not that, since sending restores the task from its archive or a
// recap), it goes to the Coordinator instead, with the task's id and the reason, so it can work out where it goes.

/** The Coordinator's copy of a card reply its task refused: what it was for, why it came here, then Cody's words. */
export function reroutedMessage(task: { id: string; title: string }, reason: string, text: string): string {
  const why = reason.trim().replace(/\.$/, "")
  return `↪️ Rerouted from my reply to the task "${task.title}" (${task.id}), which couldn't take it${why ? `: ${why}` : ""}. Please work out where it should go.\n\n${text}`
}

