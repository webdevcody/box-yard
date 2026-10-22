import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type Ref } from "react"
import { AlertTriangle, FileText, Loader2, Paperclip, Send, X } from "lucide-react"
import { uploadFile } from "../lib/api"
import { useSettings } from "../lib/queries"
import { Button, cx } from "./ui"
import { formatSize, isImage } from "./Attachments"
import type { Attachment } from "../../../shared/types"

interface Pending {
  key: number
  name: string
  size: number
  mime: string
  preview: string | null
  status: "uploading" | "done" | "error"
  error?: string
  attachment?: Attachment
}

let nextKey = 0

/**
 * The message box shared by the orchestrator chat and task threads: Enter
 * sends, Shift+Enter adds a line, files can be picked, dropped or pasted.
 * `onSubmit` gets the uploaded files; the box clears its own attachments.
 */
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
  onSubmit: (attachments: Attachment[]) => void
  placeholder: string
  className?: string
  textareaRef?: Ref<HTMLTextAreaElement>
}) {
  const [files, setFiles] = useState<Pending[]>([])
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const maxMb = useSettings().data?.maxUploadMb ?? 20
  const filesRef = useRef(files)
  filesRef.current = files

  useEffect(() => () => filesRef.current.forEach((f) => f.preview && URL.revokeObjectURL(f.preview)), [])

  const patch = (key: number, change: Partial<Pending>) => setFiles((list) => list.map((f) => (f.key === key ? { ...f, ...change } : f)))

  const add = (picked: File[]) => {
    for (const file of picked) {
      const key = nextKey++
      const item: Pending = {
        key,
        name: file.name || "pasted-file",
        size: file.size,
        mime: file.type || "application/octet-stream",
        preview: isImage(file.type) ? URL.createObjectURL(file) : null,
        status: "uploading",
      }
      if (file.size > maxMb * 1024 * 1024) {
        setFiles((list) => [...list, { ...item, status: "error", error: `"${item.name}" is larger than the ${maxMb} MB upload limit.` }])
        continue
      }
      setFiles((list) => [...list, item])
      uploadFile(file).then(
        (attachment) => patch(key, { status: "done", attachment }),
        (err: Error) => patch(key, { status: "error", error: err.message }),
      )
    }
  }

  const remove = (key: number) =>
    setFiles((list) => {
      const gone = list.find((f) => f.key === key)
      if (gone?.preview) URL.revokeObjectURL(gone.preview)
      return list.filter((f) => f.key !== key)
    })

  const uploading = files.some((f) => f.status === "uploading")
  const ready = files.flatMap((f) => (f.attachment ? [f.attachment] : []))
  const canSend = !uploading && Boolean(value.trim() || ready.length)

  const submit = () => {
    if (!canSend) return
    onSubmit(ready)
    files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview))
    setFiles([])
  }

  const onPaste = (e: ClipboardEvent) => {
    const pasted = Array.from(e.clipboardData.files)
    if (!pasted.length) return
    e.preventDefault()
    add(pasted)
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    add(Array.from(e.dataTransfer.files))
  }

  return (
    <form
      className={className}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <div
        className={cx(
          "rounded-xl border bg-zinc-900 p-2 focus-within:border-yard-500/50",
          dragging ? "border-yard-500 ring-1 ring-yard-500/40" : "border-zinc-800",
        )}
      >
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-1 pb-2">
            {files.map((f) => (
              <div
                key={f.key}
                title={f.error ?? `${f.name} · ${formatSize(f.size)}`}
                className={cx(
                  "relative flex items-center gap-1.5 rounded-lg border bg-zinc-950 text-xs text-zinc-300",
                  f.preview ? "p-0.5" : "py-1 pr-6 pl-2",
                  f.status === "error" ? "border-red-900/60 text-red-300" : "border-zinc-800",
                )}
              >
                {f.preview ? (
                  <img src={f.preview} alt={f.name} className={cx("h-14 w-14 rounded-md object-cover", f.status !== "done" && "opacity-50")} />
                ) : f.status === "error" ? (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                )}
                {!f.preview && (
                  <span className="max-w-[10rem] truncate">
                    {f.name} <span className="text-zinc-600">{formatSize(f.size)}</span>
                  </span>
                )}
                {f.status === "uploading" && <Loader2 className="absolute top-1 left-1 h-3.5 w-3.5 animate-spin text-zinc-200" />}
                {f.preview && f.status === "error" && <AlertTriangle className="absolute top-1 left-1 h-3.5 w-3.5 text-red-400" />}
                <button
                  type="button"
                  onClick={() => remove(f.key)}
                  aria-label={`Remove ${f.name}`}
                  className="absolute top-0.5 right-0.5 rounded-full bg-zinc-800 p-0.5 text-zinc-400 hover:text-zinc-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {files.some((f) => f.status === "error") && (
          <div className="px-2 pb-1 text-xs text-red-400">{files.find((f) => f.status === "error")!.error}</div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              add(Array.from(e.target.files ?? []))
              e.target.value = ""
            }}
          />
          <Button type="button" variant="ghost" size="sm" className="h-8 w-8 !p-0" title="Attach files" onClick={() => picker.current?.click()}>
            <Paperclip className="h-4 w-4" />
          </Button>
          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={placeholder}
            className="max-h-40 min-h-[2.25rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
            style={{ height: Math.min(160, 36 + (value.split("\n").length - 1) * 20) }}
          />
          <Button type="submit" variant="primary" size="sm" className="h-8 w-8 !p-0" disabled={!canSend}>
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </form>
  )
}
