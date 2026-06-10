import * as React from "react";

/** "Al día" brand mark — a geometric check inside an open ring. 1-color,
 *  recolorable via currentColor, scales to a favicon. Decoupled from the
 *  wordmark so the name can change without touching the mark. */
export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      className={className}
      style={{ display: "block" }}
      aria-hidden="true"
    >
      <circle cx="50" cy="50" r="30" stroke="currentColor" strokeWidth="7.5" opacity="0.4" />
      <path d="M35 51 L46 63 L67 38" stroke="currentColor" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
