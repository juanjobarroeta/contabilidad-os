import * as React from "react";
import { cn } from "@/lib/utils";

/** Standard panel: white, bordered, rounded-xl. Replaces the repeated
 *  `bg-white rounded-xl border border-border` across pages. */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("bg-card text-card-foreground rounded-xl border border-border", className)}
      {...props}
    />
  );
}

/** Card header row with a bottom border — for titled panels. */
export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("px-5 py-4 border-b border-border flex items-center justify-between gap-2", className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("font-semibold text-sm", className)} {...props} />;
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5", className)} {...props} />;
}
