import * as React from "react";
import { cn } from "@/lib/utils";

/** en-US grouping with a $ prefix and fixed decimals — matches the design spec
 *  ("money strings must never truncate"; always tabular so columns align). */
function fmtMoney(n: number, decimals = 2) {
  return (
    "$" +
    Number(n).toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
  );
}

export interface MoneyProps extends React.HTMLAttributes<HTMLSpanElement> {
  value: number;
  /** Prefix "+" and color positive/negative (jade/red). */
  sign?: boolean;
  /** Force the muted (ink-soft) color regardless of sign. */
  muted?: boolean;
  decimals?: number;
  /** Font size in px (design uses 16–42 across screens). */
  size?: number;
  weight?: number;
}

/** Tabular monospace figure. The single source of truth for rendering money,
 *  so every column aligns and nothing truncates. */
export function Money({
  value,
  sign = false,
  muted = false,
  decimals = 2,
  size,
  weight = 600,
  className,
  style,
  ...rest
}: MoneyProps) {
  const n = Number(value);
  const color = muted
    ? "text-cos-ink-soft"
    : sign && n > 0
      ? "text-cos-jade-ink"
      : sign && n < 0
        ? "text-cos-red-ink"
        : "text-cos-ink";
  const text = (sign && n > 0 ? "+" : "") + fmtMoney(n, decimals);
  return (
    <span
      className={cn(
        "font-mono tabular-nums tracking-[-0.01em] whitespace-nowrap",
        color,
        className
      )}
      style={{ fontSize: size, fontWeight: weight, ...style }}
      {...rest}
    >
      {text}
    </span>
  );
}
