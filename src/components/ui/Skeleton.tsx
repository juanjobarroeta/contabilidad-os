import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Placeholder con la FORMA del contenido que está por llegar, en vez de un
 * spinner centrado. Importa aquí más que en una app cualquiera: el tablero
 * tarda porque agrega CFDIs del período, y un spinner no dice si vendrán tres
 * tarjetas o quince renglones — el layout salta cuando por fin cargan.
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse rounded-md bg-cos-slate-tint", className)}
      {...props}
    />
  );
}

/** Bloque de líneas de texto; la última sale más corta, como un párrafo real. */
export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={cn("h-3.5", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

/** Tarjeta con título + cifra, del alto de una tarjeta de KPI real. */
export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn("rounded-card border border-cos-line bg-cos-card p-5", className)}>
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-7 w-36" />
      <Skeleton className="mt-2.5 h-3 w-full" />
    </div>
  );
}

/** Renglones de tabla mientras llega la primera página de datos. */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("divide-y divide-cos-line", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3.5">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-3.5 w-20" />
        </div>
      ))}
    </div>
  );
}
