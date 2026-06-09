import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // ── Contia redesign palette (namespaced so it never shadows Tailwind's
        // built-in red/amber/slate scales the rest of the app still uses). ──
        cos: {
          brand: {
            DEFAULT: "var(--brand)",
            deep: "var(--brand-deep)",
            tint: "var(--brand-tint)",
            ink: "var(--brand-ink)",
          },
          jade: { DEFAULT: "var(--jade)", tint: "var(--jade-tint)", ink: "var(--jade-ink)" },
          amber: { DEFAULT: "var(--amber)", tint: "var(--amber-tint)", ink: "var(--amber-ink)" },
          red: { DEFAULT: "var(--red)", tint: "var(--red-tint)", ink: "var(--red-ink)" },
          ink: { DEFAULT: "var(--ink)", soft: "var(--ink-soft)", faint: "var(--ink-faint)" },
          line: { DEFAULT: "var(--line)", soft: "var(--line-soft)" },
          paper: "var(--paper)",
          slate: { tint: "var(--slate-tint)" },
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        card: "16px",
        control: "11px",
      },
      boxShadow: {
        card: "0 1px 2px oklch(0.4 0.05 258 / 0.04), 0 8px 24px -16px oklch(0.4 0.05 258 / 0.18)",
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
