import type { SVGProps } from "react"
import { useId } from "react"
import { cx } from "./ui"

type BrandMarkProps = SVGProps<SVGSVGElement> & {
  title?: string
}

export function BrandMark({ className, title, ...props }: BrandMarkProps) {
  const titleId = useId()

  return (
    <svg
      viewBox="0 0 64 64"
      role={title ? "img" : undefined}
      aria-labelledby={title ? titleId : undefined}
      aria-hidden={title ? undefined : true}
      className={className}
      {...props}
    >
      {title && <title id={titleId}>{title}</title>}
      <g fill="#27272a" stroke="#3f3f46" strokeWidth="1">
        <rect x="4" y="4" width="16" height="16" rx="4" />
        <rect x="24" y="4" width="16" height="16" rx="4" />
        <rect x="24" y="24" width="16" height="16" rx="4" />
        <rect x="44" y="24" width="16" height="16" rx="4" />
        <rect x="4" y="44" width="16" height="16" rx="4" />
        <rect x="44" y="44" width="16" height="16" rx="4" />
      </g>
      <g filter="drop-shadow(0 0 6px rgba(251, 191, 36, 0.65))">
        <rect x="44" y="4" width="16" height="16" rx="4" fill="#f59e0b" stroke="#fbbf24" strokeWidth="1" />
        <rect x="4" y="24" width="16" height="16" rx="4" fill="#f59e0b" stroke="#fbbf24" strokeWidth="1" />
        <rect x="24" y="44" width="16" height="16" rx="4" fill="#f59e0b" stroke="#fbbf24" strokeWidth="1" />
      </g>
    </svg>
  )
}

export function BrandLogo({
  className,
  markClassName = "h-7 w-7",
  textClassName = "font-semibold tracking-tight text-zinc-50",
}: {
  className?: string
  markClassName?: string
  textClassName?: string
}) {
  return (
    <div className={cx("flex min-w-0 items-center gap-2", className)}>
      <BrandMark className={cx("shrink-0", markClassName)} />
      <span className={cx("truncate", textClassName)}>Box Yard</span>
    </div>
  )
}
