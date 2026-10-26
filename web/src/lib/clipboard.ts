// Copying text. navigator.clipboard only exists in secure contexts (https or localhost), and Box Yard is often
// opened over plain http on the LAN, so without it a hidden textarea and execCommand("copy") do the job.

/** Copy `text` exactly. Resolves false when the browser refused both ways. */
export async function copyText(text: string, clipboard: Pick<Clipboard, "writeText"> | undefined = navigator.clipboard): Promise<boolean> {
  if (clipboard) {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      // Denied (no permission, document not focused): try the old way.
    }
  }
  return copyWithTextarea(text)
}

function copyWithTextarea(text: string): boolean {
  const area = document.createElement("textarea")
  area.value = text
  area.setAttribute("readonly", "")
  // Off screen and unscrolled, so selecting it neither shows it nor scrolls the page (iOS zooms into a focused
  // input under 16px).
  area.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0;font-size:16px"
  const focused = document.activeElement as HTMLElement | null
  document.body.append(area)
  area.select()
  area.setSelectionRange(0, text.length)
  let ok = false
  try {
    ok = document.execCommand("copy")
  } catch {
    ok = false
  }
  area.remove()
  focused?.focus?.({ preventScroll: true })
  return ok
}
