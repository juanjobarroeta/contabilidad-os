import { describe, it, expect } from "vitest";
import { TRANSICIONES_DEPOSITO, cambiarEstadoDeposito, crearDeposito, resumenDepositos } from "./depositos";
import { DbFalsa, comoDb } from "./__fixtures__/db-falsa";

describe("resumenDepositos()", () => {
  it("suma por estado; vigentes = recibidos + aplicados", () => {
    const r = resumenDepositos([
      { estado: "RECIBIDO", monto: 5000 },
      { estado: "APLICADO", monto: 3000.5 },
      { estado: "DEVUELTO", monto: 1000 },
      { estado: "CANCELADO", monto: 99 },
    ]);
    expect(r).toEqual({ recibidos: 5000, aplicados: 3000.5, devueltos: 1000, cancelados: 99, vigentes: 8000.5 });
  });

  it("sólo RECIBIDO cambia de estado", () => {
    expect(TRANSICIONES_DEPOSITO.RECIBIDO).toEqual(["APLICADO", "DEVUELTO", "CANCELADO"]);
    expect(TRANSICIONES_DEPOSITO.APLICADO).toEqual([]);
    expect(TRANSICIONES_DEPOSITO.DEVUELTO).toEqual([]);
    expect(TRANSICIONES_DEPOSITO.CANCELADO).toEqual([]);
  });
});

describe("crearDeposito() / cambiarEstadoDeposito() con el libro", () => {
  function armar(activa: boolean) {
    const db = new DbFalsa().sembrar(["101.01", "102.01", "105.01"]);
    db.configRow = { contabilidadActiva: activa, cuentasContables: null };
    db.episodios.push({ id: "e1", companyId: "c1", folio: "HOSP-1", estado: "HOSPITALIZADO" });
    return db;
  }

  it("recibir asienta y aplicar asienta su etapa; cada estado una sola vez", async () => {
    const db = armar(true);
    const d = await crearDeposito(comoDb(db), { companyId: "c1", episodioId: "e1", fecha: new Date("2026-09-01T16:00:00Z"), monto: 5000, formaPago: "EFECTIVO" });
    expect(d.estado).toBe("RECIBIDO");
    expect(d.asientoAt).toBeInstanceOf(Date);
    expect(db.pares()).toMatchObject([{ referenciaTipo: "HOSP_DEPOSITO_RECIBIDO", cargo: "101.01", abono: "206.01", monto: 5000 }]);

    const a = await cambiarEstadoDeposito(comoDb(db), { companyId: "c1", depositoId: d.id, estado: "APLICADO", fecha: new Date("2026-09-06T12:00:00Z") });
    expect(a.estado).toBe("APLICADO");
    expect(a.aplicadoAt?.toISOString()).toBe("2026-09-06T12:00:00.000Z");
    expect(db.pares().map((p) => p.referenciaTipo)).toEqual(["HOSP_DEPOSITO_RECIBIDO", "HOSP_DEPOSITO_APLICADO"]);

    await expect(cambiarEstadoDeposito(comoDb(db), { companyId: "c1", depositoId: d.id, estado: "DEVUELTO" })).rejects.toMatchObject({ status: 409 });
  });

  it("valida monto, episodio y empresa", async () => {
    const db = armar(true);
    await expect(crearDeposito(comoDb(db), { companyId: "c1", episodioId: "e1", fecha: new Date(), monto: 0, formaPago: "EFECTIVO" })).rejects.toMatchObject({ status: 400 });
    await expect(crearDeposito(comoDb(db), { companyId: "otra", episodioId: "e1", fecha: new Date(), monto: 10, formaPago: "EFECTIVO" })).rejects.toMatchObject({ status: 404 });
    db.episodios[0].estado = "CANCELADO";
    await expect(crearDeposito(comoDb(db), { companyId: "c1", episodioId: "e1", fecha: new Date(), monto: 10, formaPago: "EFECTIVO" })).rejects.toMatchObject({ status: 409 });
  });

  it("con la contabilidad apagada el depósito vive igual, sin asiento", async () => {
    const db = armar(false);
    const d = await crearDeposito(comoDb(db), { companyId: "c1", episodioId: "e1", fecha: new Date(), monto: 800, formaPago: "TARJETA" });
    expect(d.asientoAt).toBeNull();
    expect(db.asientos).toHaveLength(0);
  });
});
