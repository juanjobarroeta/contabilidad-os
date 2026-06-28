import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Único sistema de color (se retiró el tema legacy shadcn). Namespaced
        // `cos-` para no pisar las escalas integradas de Tailwind.
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
