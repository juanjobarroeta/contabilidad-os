import { describe, it, expect } from "vitest";
import { decideEscritura } from "./subscription-gate";

describe("decideEscritura", () => {
  it("bandera apagada: todo pasa, incluso EXPIRED", () => {
    const d = decideEscritura({ habilitado: false, esOperador: false, status: "EXPIRED" });
    expect(d.permitido).toBe(true);
    expect(d.permitido && d.advertencia).toBeNull();
  });

  it("bandera apagada: CANCELED también pasa", () => {
    expect(
      decideEscritura({ habilitado: false, esOperador: false, status: "CANCELED" }).permitido
    ).toBe(true);
  });

  it("bandera encendida + EXPIRED: bloquea con el mensaje 402 de prueba vencida", () => {
    const d = decideEscritura({ habilitado: true, esOperador: false, status: "EXPIRED" });
    expect(d.permitido).toBe(false);
    if (!d.permitido) {
      expect(d.motivo).toBe("Tu prueba terminó. Activa tu suscripción para continuar.");
    }
  });

  it("bandera encendida + CANCELED: bloquea con mensaje de cancelación", () => {
    const d = decideEscritura({ habilitado: true, esOperador: false, status: "CANCELED" });
    expect(d.permitido).toBe(false);
    if (!d.permitido) expect(d.motivo).toMatch(/cancelada/i);
  });

  it("ACTIVE: pasa sin advertencia", () => {
    const d = decideEscritura({ habilitado: true, esOperador: false, status: "ACTIVE" });
    expect(d).toEqual({ permitido: true, advertencia: null });
  });

  it("TRIALING vigente (estado efectivo): pasa sin advertencia", () => {
    // computeState() ya convierte un TRIALING con trialEndsAt vencido en
    // EXPIRED, así que aquí TRIALING significa prueba vigente.
    const d = decideEscritura({ habilitado: true, esOperador: false, status: "TRIALING" });
    expect(d).toEqual({ permitido: true, advertencia: null });
  });

  it("PAST_DUE: periodo de gracia — escribe, pero con advertencia", () => {
    const d = decideEscritura({ habilitado: true, esOperador: false, status: "PAST_DUE" });
    expect(d.permitido).toBe(true);
    if (d.permitido) {
      expect(d.advertencia).toMatch(/pago no se pudo procesar/i);
    }
  });

  it("el operador de plataforma nunca se bloquea", () => {
    for (const status of ["EXPIRED", "CANCELED", "PAST_DUE"] as const) {
      const d = decideEscritura({ habilitado: true, esOperador: true, status });
      expect(d).toEqual({ permitido: true, advertencia: null });
    }
  });
});
