import { describe, it, expect } from "vitest";
import { retirarActivosPorReclasificacion } from "./auto-activo";

/** Sólo `activoFijo.deleteMany`, y guarda el `where` para poder mirarlo. */
function dbFalsa() {
  const visto: { where?: Record<string, unknown>; llamadas: number } = { llamadas: 0 };
  const db = {
    activoFijo: {
      deleteMany: async (args: { where: Record<string, unknown> }) => {
        visto.where = args.where;
        visto.llamadas++;
        return { count: 1 };
      },
    },
  };
  return { db: db as never, visto };
}

// Un CFDI con usoCfdi I01–I08 crea un activo solo. Reclasificarlo a GASTO
// deduce el CFDI completo, y si el activo se queda sigue depreciándose: la
// misma compra deducida dos veces, en dos pantallas distintas.
describe("retirarActivosPorReclasificacion()", () => {
  it("de INVERSIÓN a GASTO se lleva el activo que creó el sistema", async () => {
    const { db, visto } = dbFalsa();
    expect(await retirarActivosPorReclasificacion(db, { companyId: "c1", invoiceId: "f1", naturaleza: "GASTO" })).toBe(1);
    expect(visto.where).toEqual({ companyId: "c1", invoiceId: "f1", autoCreado: true });
  });

  it("igual con INVENTARIO y SIN_EFECTOS: lo que no es inversión no se deprecia", async () => {
    for (const naturaleza of ["INVENTARIO", "SIN_EFECTOS"]) {
      const { db } = dbFalsa();
      expect(await retirarActivosPorReclasificacion(db, { companyId: "c1", invoiceId: "f1", naturaleza })).toBe(1);
    }
  });

  it("sigue siendo INVERSIÓN: no toca nada", async () => {
    const { db, visto } = dbFalsa();
    expect(await retirarActivosPorReclasificacion(db, { companyId: "c1", invoiceId: "f1", naturaleza: "INVERSION" })).toBe(0);
    expect(visto.llamadas).toBe(0);
  });

  it("nunca se lleva uno capturado o ya revisado: el filtro exige autoCreado", async () => {
    const { db, visto } = dbFalsa();
    await retirarActivosPorReclasificacion(db, { companyId: "c1", invoiceId: "f1", naturaleza: "GASTO" });
    expect(visto.where?.autoCreado).toBe(true);
  });
});
