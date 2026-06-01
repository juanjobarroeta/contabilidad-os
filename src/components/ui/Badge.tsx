import * as React from "react";
import { cn } from "@/lib/utils";

// Unified semantic colors so a "green" means the same thing across every page
// (was spread across green-50/green-100/green-600 etc. per page).
export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "primary";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-gray-100 text-gray-700",
  success: "bg-green-50 text-green-700",
  warning: "bg-amber-50 text-amber-700",
  danger: "bg-red-50 text-red-700",
  info: "bg-blue-50 text-blue-700",
  primary: "bg-primary text-primary-foreground",
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
