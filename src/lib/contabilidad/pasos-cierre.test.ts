import { describe, it, expect } from "vitest";
import { estadoDeLosPasos } from "./pasos-cierre";
import type { ReadinessResult, CheckEstado } from "./ce-readiness";

const chk = (clave: string, estado: CheckEstado, titulo = `${clave}:${estado}`) => ({
  clave, estado, titulo, detalle: "",
});
const res = (...checks: ReturnType<typeof chk>[]): ReadinessResult =>
  ({ status: "lista", resumen: "", checks });

const porClave = (pasos: ReturnType<typeof estadoDeLosPasos>) =>
  Object.fromEntries(pasos.map((p) => [p.clave, p]));

describe("estadoDeLosPasos", () => {
  it("sin resultado, ningún paso finge saber", () => {
    const p = estadoDeLosPasos(null);
    expect(p).toHaveLength(5);
    expect(p.every((x) => x.estado === "sin_datos" && x.detalle === null)).toBe(true);
  });

  it("devuelve los cinco pasos en el orden del flujo", () => {
    expect(estadoDeLosPasos(res()).map((p) => p.clave))
      .toEqual(["cierre", "conciliacion", "divergencia", "ajustes", "entregables"]);
  });

  it("cada paso lee SUS checks", () => {
    const p = porClave(estadoDeLosPasos(res(
      chk("cfdis", "ok"), chk("banco", "ok"), chk("sin_clasificar", "ok"),
      chk("cuadre", "ok"), chk("posteo", "ok"),
    )));
    expect(p.cierre.estado).toBe("listo");
    expect(p.conciliacion.estado).toBe("listo");
    expect(p.divergencia.estado).toBe("listo");
    expect(p.ajustes.estado).toBe("listo");
  });

  it("EL NÚMERO viaja: el título del check es el detalle del paso", () => {
    // Es literalmente lo que el brief pedía y no se entregó.
    const p = porClave(estadoDeLosPasos(res(
      chk("banco", "ok"),
      chk("sin_clasificar", "warn", "43 movimiento(s) sin clasificar"),
    )));
    expect(p.conciliacion.detalle).toBe("43 movimiento(s) sin clasificar");
  });

  it("dentro de un paso manda el check MÁS GRAVE", () => {
    const p = porClave(estadoDeLosPasos(res(
      chk("banco", "error", "Sin movimientos bancarios del periodo"),
      chk("sin_clasificar", "ok"),
    )));
    expect(p.conciliacion.estado).toBe("bloquea");
    expect(p.conciliacion.detalle).toBe("Sin movimientos bancarios del periodo");
  });

  it("un error BLOQUEA a los pasos que siguen, aunque estén limpios", () => {
    // Decirle "listo" a Entregables mientras la conciliación bloquea el posteo
    // sería mentir sobre lo único que el contador vino a saber.
    const p = porClave(estadoDeLosPasos(res(
      chk("cfdis", "ok"),
      chk("banco", "error"),
      chk("cuadre", "ok"),
      chk("posteo", "ok"),
    )));
    expect(p.cierre.estado).toBe("listo");         // antes del bloqueo: intacto
    expect(p.conciliacion.estado).toBe("bloquea");
    expect(p.divergencia.estado).toBe("espera");   // aunque su check esté ok
    expect(p.ajustes.estado).toBe("espera");
    expect(p.entregables.estado).toBe("espera");
  });

  it("un warn NO bloquea: los siguientes siguen evaluándose solos", () => {
    const p = porClave(estadoDeLosPasos(res(
      chk("sin_clasificar", "warn"), chk("banco", "ok"), chk("cuadre", "ok"),
    )));
    expect(p.conciliacion.estado).toBe("atencion");
    expect(p.divergencia.estado).toBe("listo");
  });

  it("un paso sin checks del periodo dice sin_datos, no verde", () => {
    const p = porClave(estadoDeLosPasos(res(chk("cfdis", "ok"))));
    expect(p.conciliacion.estado).toBe("sin_datos");
    expect(p.entregables.estado).toBe("sin_datos");
  });

  it("el capital inicial cuenta para el paso de Cierre", () => {
    const p = porClave(estadoDeLosPasos(res(
      chk("cfdis", "ok"), chk("capital_inicial", "warn", "Falta capital inicial"),
    )));
    expect(p.cierre.estado).toBe("atencion");
    expect(p.cierre.detalle).toBe("Falta capital inicial");
  });
});
