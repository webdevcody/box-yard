// The ordered list of RunPod GPU types a pod tries, with each one's VRAM, live price on the chosen cloud, stock and
// what it's good for. Settings › RunPod GPU edits the global list; Project › Settings › Boxes a project's own.
import { ArrowUp, X } from "lucide-react"
import { useRunPodGpus } from "../lib/queries"
import { gpuHint, gpuPrice, shortGpu, type RunPodCloud, type RunPodGpuOption } from "../../../shared/runpod"
import { Select } from "./ui"

const usd = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`)

/** "16 GB · $0.25/hr · low stock · browser and WebGL game testing", or why it can't run on this cloud. */
export function gpuOptionLine(g: RunPodGpuOption, cloud: RunPodCloud) {
  const price = gpuPrice(g, cloud)
  const where = price === null ? (cloud === "SECURE" ? "Community Cloud only" : "Secure Cloud only") : `${usd(price)}/hr · ${g.availability.toLowerCase()} stock`
  return [`${g.memoryGb} GB`, where, g.use].filter(Boolean).join(" · ")
}

export function GpuTypePicker({ id, value, onChange, cloud, enabled }: { id: string; value: string[]; onChange: (v: string[]) => void; cloud: RunPodCloud; enabled: boolean }) {
  const gpus = useRunPodGpus({ enabled })
  const info = (gid: string) => gpus.data?.find((g) => g.id === gid)
  const options = (gpus.data ?? []).filter((g) => !value.includes(g.id))
  return (
    <div className="w-full min-w-0 space-y-1.5">
      <ol className="space-y-1" data-testid={`${id}-list`}>
        {value.map((gid, i) => {
          const g = info(gid)
          const off = g && gpuPrice(g, cloud) === null
          return (
            <li key={gid} className="flex items-center gap-2 rounded-lg bg-zinc-900 px-2 py-1 text-xs">
              <span className="flex-1 text-zinc-200">
                {shortGpu(gid)}
                <span className={off ? "ml-1 text-amber-300" : "ml-1 text-zinc-500"}>{g ? gpuOptionLine(g, cloud) : (gpuHint(gid) ?? "")}</span>
              </span>
              {i > 0 && (
                <button type="button" title="Try it earlier" className="text-zinc-500 hover:text-zinc-200" onClick={() => onChange([gid, ...value.filter((x) => x !== gid)])}>
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
              )}
              {value.length > 1 && (
                <button type="button" title="Remove" className="text-zinc-500 hover:text-red-300" onClick={() => onChange(value.filter((x) => x !== gid))}>
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          )
        })}
      </ol>
      {enabled && (
        <Select id={id} size="sm" className="w-full" value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])} data-testid={id}>
          <option value="">{gpus.isLoading ? "Loading GPU types…" : gpus.error ? "Couldn't load RunPod's GPU types" : "Add a GPU type…"}</option>
          {options.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} · {gpuOptionLine(g, cloud)}
            </option>
          ))}
        </Select>
      )}
    </div>
  )
}
