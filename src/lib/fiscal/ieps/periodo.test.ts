import { describe, expect, it } from "vitest";
import { aPagarIeps, periodoIeps, type RenglonIeps } from "./periodo";
import { leerInciso } from "./incisos";

const r = (
  importe: number,
  sentido: "INGRESO" | "EGRESO",
  { tasa = 0.08, retencion = false }: { tasa?: number | null; retencion?: boolean } = {},
): RenglonIeps => ({ importe, tasa, retencion, sentido });

describe("leerInciso", () => {
  it("resuelve el 8 % a alimentos no básicos, y es acreditable por inciso", () => {
    const l = leerInciso(0.08);
    expect(l.certeza).toBe("unico");
    expect(l.candidatos[0].clave).toBe("2-I-J");
    expect(l.acreditablePorInciso).toBe(true);
  });

  it("dice que el 30 % es ambiguo y no elige entre bebida alcohólica y apuestas", () => {
    const l = leerInciso(0.3);
    expect(l.certeza).toBe("ambiguo");
    expect(l.candidatos.map((c) => c.clave).sort()).toEqual(["2-I-A", "2-II-B"]);
    // Uno acredita y el otro no: la respuesta honesta es que no se sabe.
    expect(l.acreditablePorInciso).toBeNull();
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
      r(100, "EGRESO", { tasa: 0.08 }), // 2-I-J: sí
      r(50, "EGRESO", { tasa: 0.5 }), //  2-I-B: no
      r(30, "EGRESO", { tasa: 0.3 }), //  ambiguo: no se sabe
      r(20, "EGRESO", { tasa: null }), // cuota: no se sabe
    ]);
    expect(p.pagado).toBe(200);
    expect(p.pagadoAcreditable).toBe(100);
    expect(p.pagadoNoAcreditable).toBe(50);
    expect(p.pagadoSinClasificar).toBe(50);
  });

  it("no causa IEPS quien sólo lo paga a sus proveedores", () => {
    const p = periodoIeps(2026, 8, [r(400, "EGRESO")]);
    expect(p.causa).toBe(false);
    expect(p.pagado).toBe(400);
  });
});

describe("aPagarIeps", () => {
  const conPagado = periodoIeps(2026, 8, [r(1000, "INGRESO"), r(300, "EGRESO", { tasa: 0.08 })]);

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

  it("marca incompleto el monto cuando queda IEPS pagado sin clasificar", () => {
    const p = periodoIeps(2026, 8, [r(1000, "INGRESO"), r(300, "EGRESO", { tasa: 0.3 })]);
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
