import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Variant =
  | "primary"
  | "secondary"
  | "ghost"
  | "destructive"
  | "outline"
  // ── Contia redesign variants (brand palette) ──
  | "brand"
  | "soft"
  | "ghostBrand";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  // `primary` is the Contia brand blue.
  primary: "bg-cos-brand text-white hover:bg-cos-brand-deep",
  secondary: "bg-cos-slate-tint text-cos-ink hover:brightness-95",
  ghost: "hover:bg-cos-paper hover:text-cos-ink",
  destructive: "bg-cos-red-ink text-white hover:opacity-90",
  outline: "border border-cos-line bg-transparent hover:bg-cos-paper",
  brand: "bg-cos-brand text-white hover:bg-cos-brand-deep",
  soft: "bg-cos-card border border-cos-line text-cos-ink hover:bg-cos-paper",
  ghostBrand: "bg-transparent text-cos-brand-ink hover:bg-cos-brand-tint",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-xs gap-1.5",
  md: "h-9 px-4 text-sm gap-2",
  lg: "h-11 px-6 text-sm gap-2",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

/** Shared button. Replaces hand-rolled button classes across pages. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", loading, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center rounded-md font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cos-brand focus-visible:ring-offset-1",
        "disabled:opacity-50 disabled:pointer-events-none",
        VARIANTS[variant],
        SIZES[size],
        className
      )}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  )
);
Button.displayName = "Button";
