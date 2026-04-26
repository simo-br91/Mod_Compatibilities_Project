import { cn, severityClass } from "@/lib/utils";

interface BadgeProps {
  label: string;
  variant?: "severity" | "status" | "neutral";
  severity?: string;
  className?: string;
}

export function Badge({ label, variant = "neutral", severity, className }: BadgeProps) {
  const base = "inline-flex items-center px-2 py-0.5 text-sm font-minecraft border-2 tracking-wide";
  const cls =
    variant === "severity" && severity
      ? cn(base, severityClass(severity), className)
      : cn(base, "bg-mc-stone-dark text-mc-text-muted border-mc-border", className);

  return <span className={cls}>{label}</span>;
}
