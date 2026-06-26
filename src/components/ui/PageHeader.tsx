import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Consistent page shell: one max-width + padding for every page (was max-w-6xl
 * / max-w-5xl / none, p-6 ad-hoc). Wrap page content in <PageContainer>.
 */
export function PageContainer({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4 sm:p-6 max-w-6xl mx-auto w-full", className)} {...props} />;
}

/** Consistent page header: h1 + optional subtitle + right-aligned actions. */
export function PageHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3 mb-6", className)}>
      <div className="min-w-0">
        <h1 className="text-2xl font-bold truncate text-cos-ink">{title}</h1>
        {subtitle && <p className="text-sm text-cos-ink-soft mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
