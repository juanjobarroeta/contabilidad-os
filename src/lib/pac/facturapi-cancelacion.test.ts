import { describe, it, expect } from "vitest";
import { leerCancelacionFacturapi } from "./facturapi";

describe("leerCancelacionFacturapi", () => {
  it("pendiente de aceptación → en proceso (NO se marca cancelada)", () => {
    const r = leerCancelacionFacturapi({ status: "valid", cancellation_status: "pending" });
    expect(r.estado).toBe("en_proceso");
  });

  it("aceptada por el receptor → cancelada", () => {
    expect(leerCancelacionFacturapi({ status: "canceled", cancellation_status: "accepted" }).estado).toBe("cancelado");
  });

  it("sin aceptación requerida → cancelada", () => {
    expect(leerCancelacionFacturapi({ status: "canceled", cancellation_status: "none" }).estado).toBe("cancelado");
  });

  it("«canceled» pendiente todavía NO cuenta como cancelada", () => {
    // El PAC puede reflejar la solicitud antes de que el SAT la consume.
    expect(leerCancelacionFacturapi({ status: "canceled", cancellation_status: "pending" }).estado).toBe("en_proceso");
  });

  it("una respuesta que no reconocemos NO se da por cancelada", () => {
    // Conservador por diseño: dar por cancelado lo que sigue vigente le quita
    // al mes ingresos reales; lo contrario sólo retrasa una confirmación que
    // el cron de vigencia hace solo.
    expect(leerCancelacionFacturapi({}).estado).toBe("desconocido");
    expect(leerCancelacionFacturapi(null).estado).toBe("desconocido");
    expect(leerCancelacionFacturapi({ status: "algo_raro" }).estado).toBe("desconocido");
  });

  it("guarda lo que dijo el PAC para la bitácora", () => {
    expect(leerCancelacionFacturapi({ status: "valid", cancellation_status: "pending" }).detalle).toBe(
      "status=valid cancellation_status=pending",
    );
    expect(leerCancelacionFacturapi({}).detalle).toBeNull();
  });
});
