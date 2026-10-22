import type { Ref } from "react"
import { Send } from "lucide-react"
import { Button } from "./ui"

export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  className = "border-t border-zinc-900 p-3",
  textareaRef,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  placeholder: string
  className?: string
  textareaRef?: Ref<HTMLTextAreaElement>
}) {
  return (
    <form
      className={className}
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <div className="flex items-end gap-2 rounded-xl border border-zinc-800 bg-zinc-900 p-2 focus-within:border-yard-500/50">
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              onSubmit()
            }
          }}
          placeholder={placeholder}
          className="max-h-40 min-h-[2.25rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
          style={{ height: Math.min(160, 36 + (value.split("\n").length - 1) * 20) }}
        />
        <Button type="submit" variant="primary" size="sm" className="h-8 w-8 !p-0" disabled={!value.trim()}>
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </form>
  )
}
