import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** Consistent inline loading row (was h-3.5/h-4/h-5 ad-hoc per page). */
export function Loading({ label = "Cargando…", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("flex items-center justify-center gap-2 text-sm text-muted-foreground py-8", className)}>
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
      {Icon && <Icon className="h-9 w-9 text-muted-foreground/40 mb-3" />}
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="text-xs text-muted-foreground mt-1 max-w-sm">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

type AlertTone = "success" | "danger" | "info" | "warning";
const ALERT_TONES: Record<AlertTone, string> = {
  success: "bg-green-50 border-green-200 text-green-800",
  danger: "bg-red-50 border-red-200 text-red-700",
  info: "bg-blue-50 border-blue-200 text-blue-800",
  warning: "bg-amber-50 border-amber-200 text-amber-800",
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
