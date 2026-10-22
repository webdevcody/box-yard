import { useEffect } from "react"

/** Scroll to the element `#<prefix><hash>` once `ready`, and again whenever the hash changes. */
export function useScrollToHash(ready: boolean, prefix = "") {
  useEffect(() => {
    if (!ready) return
    const go = () => {
      const id = decodeURIComponent(window.location.hash.slice(1))
      if (id) document.getElementById(`${prefix}${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
    }
    go()
    window.addEventListener("hashchange", go)
    return () => window.removeEventListener("hashchange", go)
  }, [ready, prefix])
}
