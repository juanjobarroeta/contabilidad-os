import { describe, expect, it } from "vitest";
import { aPagarIeps, periodoIeps, type RenglonIeps } from "./periodo";
import { leerInciso } from "./incisos";

const r = (
  importe: number,
  sentido: "INGRESO" | "EGRESO",
  { tasa = 0.09, retencion = false }: { tasa?: number | null; retencion?: boolean } = {},
): RenglonIeps => ({ importe, tasa, retencion, sentido });

describe("leerInciso", () => {
  it("resuelve el 9 % a plaguicidas, y es acreditable por inciso", () => {
    const l = leerInciso(0.09);
    expect(l.certeza).toBe("unico");
    expect(l.candidatos[0].clave).toBe("2-I-I");
    expect(l.acreditablePorInciso).toBe(true);
  });

  // Cotejo del 2026-09-08: la reforma DOF 07-11-2025 añadió los videojuegos
  // (2-II-D) al 8 %, la misma tasa de los alimentos no básicos. Uno acredita y
  // el otro no, así que desde el CFDI ya no se puede saber cuál es.
  it("dice que el 8 % es ambiguo entre alimentos no básicos y videojuegos", () => {
    const l = leerInciso(0.08);
    expect(l.certeza).toBe("ambiguo");
    expect(l.candidatos.map((c) => c.clave).sort()).toEqual(["2-I-J", "2-II-D"]);
    expect(l.acreditablePorInciso).toBeNull();
  });

  it("el 50 % es ambiguo pero ninguno acredita, así que la respuesta sí se sabe", () => {
    const l = leerInciso(0.5);
    expect(l.certeza).toBe("ambiguo");
    expect(l.candidatos.map((c) => c.clave).sort()).toEqual(["2-I-B", "2-II-B"]);
    expect(l.acreditablePorInciso).toBe(false);
  });

  it("el 30 % es de bebidas alcohólicas; juegos con apuestas subió a 50 % en 2025", () => {
    const l = leerInciso(0.3);
    expect(l.certeza).toBe("unico");
    expect(l.candidatos[0].clave).toBe("2-I-A");
  });

  it("no inventa inciso para una tasa que no está en el catálogo", () => {
    const l = leerInciso(0.11);
    expect(l.certeza).toBe("desconocido");
    expect(l.candidatos).toHaveLength(0);
    expect(l.acreditablePorInciso).toBeNull();
  });

  it("trata la cuota (sin tasa) como desconocida, no como cero", () => {
    expect(leerInciso(null).certeza).toBe("desconocido");
  });
});

describe("periodoIeps", () => {
  it("separa lo que cobró de lo que le cobraron", () => {
    const p = periodoIeps(2026, 8, [r(1000, "INGRESO"), r(400, "EGRESO"), r(500, "INGRESO")]);
    expect(p.periodo).toBe("2026-08");
    expect(p.trasladado).toBe(1500);
    expect(p.pagado).toBe(400);
    expect(p.renglones).toBe(3);
    expect(p.causa).toBe(true);
  });

  it("saca la retención del neto y la reporta aparte", () => {
    const p = periodoIeps(2026, 8, [r(1000, "INGRESO"), r(120, "INGRESO", { retencion: true })]);
    expect(p.trasladado).toBe(1000);
    expect(p.retenido).toBe(120);
    expect(p.renglones).toBe(1);
  });

  it("parte el pagado en acreditable, no acreditable y sin clasificar", () => {
    const p = periodoIeps(2026, 8, [
      r(100, "EGRESO", { tasa: 0.09 }), // 2-I-I: sí
      r(50, "EGRESO", { tasa: 0.5 }), //  alcohol o apuestas: ninguno acredita
      r(30, "EGRESO", { tasa: 0.08 }), // alimentos o videojuegos: no se sabe
      r(20, "EGRESO", { tasa: null }), // cuota: no se sabe
    ]);
    expect(p.pagado).toBe(200);
    expect(p.pagadoAcreditable).toBe(100);
    expect(p.pagadoNoAcreditable).toBe(50);
    expect(p.pagadoSinClasificar).toBe(50);
  });

  it("agrupa por INCISO, no por tasa: las tres tasas del 2-I-A son una clase", () => {
    const p = periodoIeps(2026, 8, [
      r(100, "INGRESO", { tasa: 0.265 }),
      r(200, "INGRESO", { tasa: 0.53 }),
    ]);
    expect(p.porTasa.map((t) => t.clase)).toEqual(["2-I-A", "2-I-A"]);
  });

  it("no causa IEPS quien sólo lo paga a sus proveedores", () => {
    const p = periodoIeps(2026, 8, [r(400, "EGRESO")]);
    expect(p.causa).toBe(false);
    expect(p.pagado).toBe(400);
  });
});

describe("aPagarIeps", () => {
  const conPagado = periodoIeps(2026, 8, [r(1000, "INGRESO"), r(300, "EGRESO", { tasa: 0.09 })]);

  it("devuelve null mientras nadie decida el Art. 4º y haya algo que decidir", () => {
    const res = aPagarIeps(conPagado, "sin_decidir");
    expect(res.monto).toBeNull();
    expect(res.completo).toBe(false);
    expect(res.motivo).toContain("Art. 4");
  });

  it("sin acreditamiento se entera todo el trasladado", () => {
    const res = aPagarIeps(conPagado, "no_acredita");
    expect(res.monto).toBe(1000);
    expect(res.acreditado).toBe(0);
    expect(res.completo).toBe(true);
  });

  it("con acreditamiento resta sólo lo que el inciso admite", () => {
    const res = aPagarIeps(conPagado, "acredita");
    expect(res.monto).toBe(700);
    expect(res.acreditado).toBe(300);
    expect(res.completo).toBe(true);
  });

  // Art. 4º fr. IV: el impuesto acreditable y el impuesto a cargo tienen que ser
  // de la MISMA clase. Restar plaguicidas contra energetizantes daría un pago
  // menor al debido.
  it("no cruza clases: lo pagado de un inciso no baja el impuesto de otro", () => {
    const p = periodoIeps(2026, 8, [
      r(1000, "INGRESO", { tasa: 0.25 }), // causa en 2-I-F
      r(400, "EGRESO", { tasa: 0.09 }), //  pagó en 2-I-I
    ]);
    const res = aPagarIeps(p, "acredita");
    expect(res.acreditado).toBe(0);
    expect(res.monto).toBe(1000);
    // Lo pagado de plaguicidas no se pierde: queda a favor de SU clase.
    expect(res.saldoFavor).toBe(400);
    expect(res.porClase.find((c) => c.clase === "2-I-I")?.saldoFavor).toBe(400);
  });

  it("el sobrante de una clase no se resta de otra: queda como saldo a favor", () => {
    const p = periodoIeps(2026, 8, [
      r(100, "INGRESO", { tasa: 0.09 }),
      r(400, "EGRESO", { tasa: 0.09 }),
    ]);
    const res = aPagarIeps(p, "acredita");
    expect(res.acreditado).toBe(100);
    expect(res.monto).toBe(0);
    expect(res.saldoFavor).toBe(300);
  });

  it("marca incompleto el monto cuando queda IEPS pagado sin clasificar", () => {
    const p = periodoIeps(2026, 8, [r(1000, "INGRESO"), r(300, "EGRESO", { tasa: 0.08 })]);
    const res = aPagarIeps(p, "acredita");
    expect(res.acreditado).toBe(0);
    expect(res.monto).toBe(1000);
    expect(res.completo).toBe(false);
    expect(res.motivo).toContain("no se pudo clasificar");
  });

  it("sin IEPS pagado la decisión no cambia el número y no se pregunta", () => {
    const p = periodoIeps(2026, 8, [r(1000, "INGRESO")]);
    const res = aPagarIeps(p, "sin_decidir");
    expect(res.monto).toBe(1000);
    expect(res.completo).toBe(true);
  });
});
