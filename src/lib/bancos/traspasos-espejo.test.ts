import { describe, expect, it } from "vitest";
import { emparejarEspejos, type MovimientoEspejo } from "./traspasos-espejo";

const F = (d: string) => new Date(`2026-08-${d}T12:00:00.000Z`);

function mov(over: Partial<MovimientoEspejo> & { id: string }): MovimientoEspejo {
  return { fecha: F("14"), monto: -230000, bankAccountId: "bbva", status: "UNMATCHED", ...over };
}

describe("emparejarEspejos — el otro lado del traspaso ya está importado", () => {
  it("caso real: sale de BBVA, entra a Banorte el mismo día", () => {
    const salida = mov({ id: "s", monto: -230000, bankAccountId: "bbva" });
    const entrada = mov({ id: "e", monto: 230000, bankAccountId: "banorte" });
    const pares = emparejarEspejos([salida, entrada], [salida, entrada]);
    expect(pares).toEqual([{ salidaId: "s", entradaId: "e", monto: 230000 }]);
  });

  it("empareja aunque la otra pata caiga al día siguiente", () => {
    const salida = mov({ id: "s", fecha: F("14") });
    const entrada = mov({ id: "e", monto: 230000, bankAccountId: "banorte", fecha: F("16") });
    expect(emparejarEspejos([salida, entrada], [salida, entrada])).toHaveLength(1);
  });

  it("más de 3 días ya no es el mismo traspaso", () => {
    const salida = mov({ id: "s", fecha: F("14") });
    const entrada = mov({ id: "e", monto: 230000, bankAccountId: "banorte", fecha: F("20") });
    expect(emparejarEspejos([salida, entrada], [salida, entrada])).toHaveLength(0);
  });

  it("la otra pata sirve aunque ya esté conciliada o ignorada", () => {
    const salida = mov({ id: "s" });
    const entrada = mov({ id: "e", monto: 230000, bankAccountId: "banorte", status: "IGNORED" });
    // Sólo la salida está pendiente; el universo trae ambas.
    expect(emparejarEspejos([salida], [salida, entrada])).toHaveLength(1);
  });

  it("no empareja dentro de la MISMA cuenta: eso no es traspaso", () => {
    const a = mov({ id: "a", monto: -5000, bankAccountId: "bbva" });
    const b = mov({ id: "b", monto: 5000, bankAccountId: "bbva" });
    expect(emparejarEspejos([a, b], [a, b])).toHaveLength(0);
  });

  it("con dos espejos posibles no se elige: adivinar marcaría un cobro real como traspaso", () => {
    const salida = mov({ id: "s", monto: -10000, bankAccountId: "bbva" });
    const e1 = mov({ id: "e1", monto: 10000, bankAccountId: "banorte" });
    const e2 = mov({ id: "e2", monto: 10000, bankAccountId: "santander" });
    expect(emparejarEspejos([salida, e1, e2], [salida, e1, e2])).toHaveLength(0);
  });

  it("unicidad MUTUA: si el candidato tiene otro pretendiente, tampoco", () => {
    const s1 = mov({ id: "s1", monto: -10000, bankAccountId: "bbva" });
    const s2 = mov({ id: "s2", monto: -10000, bankAccountId: "santander" });
    const e = mov({ id: "e", monto: 10000, bankAccountId: "banorte" });
    // `e` es el único espejo de s1, pero s1 no es el único de `e`.
    expect(emparejarEspejos([s1, s2, e], [s1, s2, e])).toHaveLength(0);
  });

  it("importes distintos no son espejo", () => {
    const salida = mov({ id: "s", monto: -230000 });
    const entrada = mov({ id: "e", monto: 229999, bankAccountId: "banorte" });
    expect(emparejarEspejos([salida, entrada], [salida, entrada])).toHaveLength(0);
  });

  it("varios traspasos distintos el mismo día se emparejan cada uno con el suyo", () => {
    const movs = [
      mov({ id: "s1", monto: -230000, bankAccountId: "bbva" }),
      mov({ id: "e1", monto: 230000, bankAccountId: "banorte" }),
      mov({ id: "s2", monto: -50000, bankAccountId: "bbva" }),
      mov({ id: "e2", monto: 50000, bankAccountId: "banorte" }),
    ];
    const pares = emparejarEspejos(movs, movs);
    expect(pares).toHaveLength(2);
    expect(pares.map((p) => p.monto).sort((a, b) => a - b)).toEqual([50000, 230000]);
  });
});
