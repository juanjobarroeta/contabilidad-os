// ─────────────────────────────────────────────────────────────────────────────
// Punto único de selección del PAC activo.
//
// Hoy: Facturapi. Para evaluar/migrar a un PAC más barato a volumen
// (SW sapien, Facturama, Finkok) basta implementar PacProvider y seleccionarlo
// aquí vía la env PAC_PROVIDER — sin tocar las rutas de facturas/nómina.
// ─────────────────────────────────────────────────────────────────────────────

import { facturapiPacProvider } from "./facturapi";
import { swSapienPacProvider } from "./swsapien";
import type { PacProvider } from "./types";

export * from "./types";

export function getPacProvider(): PacProvider {
  const which = (process.env.PAC_PROVIDER ?? "facturapi").toLowerCase();
  switch (which) {
    case "swsapien":
      return swSapienPacProvider;
    // case "facturama": return facturamaPacProvider;
    case "facturapi":
    default:
      return facturapiPacProvider;
  }
}
