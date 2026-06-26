import * as React from "react";
import { cn } from "@/lib/utils";

// Unified semantic colors so a "green" means the same thing across every page
// (was spread across green-50/green-100/green-600 etc. per page).
export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "primary";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-cos-slate-tint text-cos-ink-soft",
  success: "bg-cos-jade-tint text-cos-jade-ink",
  warning: "bg-cos-amber-tint text-cos-amber-ink",
  danger: "bg-cos-red-tint text-cos-red-ink",
  info: "bg-cos-brand-tint text-cos-brand-ink",
  primary: "bg-cos-brand text-white",
};

export function Badge({
  tone = "neutral",
  pill = true,
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone; pill?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 text-xs font-medium",
        pill ? "rounded-full" : "rounded",
        TONES[tone],
        className
      )}
      {...props}
    />
  );
}
