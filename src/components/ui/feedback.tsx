import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** Consistent inline loading row (was h-3.5/h-4/h-5 ad-hoc per page). */
export function Loading({ label = "Cargando…", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("flex items-center justify-center gap-2 text-sm text-cos-ink-soft py-8", className)}>
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

/** Consistent empty state: icon + heading + optional CTA. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center text-center px-6 py-12", className)}>
      {Icon && <Icon className="h-9 w-9 text-cos-ink-faint mb-3" />}
      <p className="text-sm font-medium text-cos-ink">{title}</p>
      {description && <p className="text-xs text-cos-ink-soft mt-1 max-w-sm">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

type AlertTone = "success" | "danger" | "info" | "warning";
const ALERT_TONES: Record<AlertTone, string> = {
  success: "bg-cos-jade-tint border-cos-jade-ink/20 text-cos-jade-ink",
  danger: "bg-cos-red-tint border-cos-red-ink/20 text-cos-red-ink",
  info: "bg-cos-brand-tint border-cos-brand-ink/15 text-cos-brand-ink",
  warning: "bg-cos-amber-tint border-cos-amber-ink/20 text-cos-amber-ink",
};

/** Consistent inline alert/banner (was styled slightly differently per page). */
export function Alert({
  tone = "info",
  className,
  children,
}: {
  tone?: AlertTone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-lg border px-4 py-3 text-sm", ALERT_TONES[tone], className)}>{children}</div>
  );
}
