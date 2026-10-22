import { useEffect } from "react"

/** Scroll to the element named by the URL hash (`#<id>`), on load and when the hash changes. */
export function useScrollToHash(ready: boolean, elementId: (id: string) => string = (id) => id) {
  useEffect(() => {
    if (!ready) return
    const go = () => {
      const id = decodeURIComponent(window.location.hash.slice(1))
      if (id) document.getElementById(elementId(id))?.scrollIntoView({ behavior: "smooth", block: "center" })
    }
    go()
    window.addEventListener("hashchange", go)
    return () => window.removeEventListener("hashchange", go)
  }, [ready])
}
