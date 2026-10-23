// The padding around every page in the main column (App.tsx), and its undo for pages whose chat runs to the bottom.

/** Inset of the page container in the main column. */
export const PAGE_PADDING = "px-4 py-4 sm:px-6 sm:py-6"

/**
 * For a full-height page whose last child is a chat (the project Captain tab): grow by the page's bottom
 * padding and pull it back with a negative margin, so its Composer sits flush with the window bottom
 * like the Coordinator panel's (Captain tab, task page). Must stay in step with PAGE_PADDING's bottom padding.
 */
export const PAGE_BLEED_BOTTOM = "-mb-4 h-[calc(100%+1rem)] sm:-mb-6 sm:h-[calc(100%+1.5rem)]"
