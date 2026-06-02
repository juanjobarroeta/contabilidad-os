import type { MetadataRoute } from "next";

// PWA manifest — makes ContabilidadOS installable ("Add to Home Screen") with
// an icon, full-screen standalone display, and the brand color.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ContabilidadOS",
    short_name: "Contabilidad",
    description: "Tu contador inteligente: CFDIs, IVA/ISR, conciliación y más.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#2563EB",
    lang: "es-MX",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
