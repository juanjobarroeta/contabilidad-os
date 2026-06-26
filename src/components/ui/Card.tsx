import * as React from "react";
import { cn } from "@/lib/utils";

/** Standard panel: white, bordered, rounded. Replaces the repeated
 *  bordered-panel classes across pages. */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("bg-white text-cos-ink rounded-card border border-cos-line", className)}
      {...props}
    />
  );
}

/** Card header row with a bottom border — for titled panels. */
export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("px-5 py-4 border-b border-cos-line flex items-center justify-between gap-2", className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("font-semibold text-sm text-cos-ink", className)} {...props} />;
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5", className)} {...props} />;
}
