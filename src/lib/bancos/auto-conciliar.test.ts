import { describe, it, expect } from "vitest";
import {
  scoreCandidate,
  isAutoApplicable,
  AUTO_MATCH_MIN_SCORE,
  AUTO_MATCH_AMBIGUITY_GAP,
  PUNTOS_CLABE_CONOCIDA,
  PUNTOS_RFC_EXACTO,
  mismoNombre,
} from "./auto-conciliar";

const tx = { fecha: new Date("2026-06-10T00:00:00Z"), descripcion: "SPEI RECIBIDO" };

describe("scoreCandidate (misma fórmula que el match route)", () => {
  it("monto exacto + fecha ≤1d = 130 (umbral de auto-aplicación)", () => {
    const inv = { total: 1000, fecha: new Date("2026-06-10T00:00:00Z"), customerRfc: null };
    expect(scoreCandidate(inv, tx, 1000)).toBe(130); // 100 (exacto) + 30 (≤1d)
  });

  it("monto exacto + fecha a 5d = 110 (no alcanza el umbral)", () => {
    const inv = { total: 1000, fecha: new Date("2026-06-05T00:00:00Z"), customerRfc: null };
    expect(scoreCandidate(inv, tx, 1000)).toBe(110); // 100 + 10 (≤7d)
  });

  it("suma 25 cuando el RFC aparece en la descripción", () => {
    const inv = {
      total: 1000,
      fecha: new Date("2026-06-10T00:00:00Z"),
      customerRfc: "XAXX010101000",
    };
    const txConRfc = { ...tx, descripcion: "SPEI XAXX010101000 PAGO" };
    expect(scoreCandidate(inv, txConRfc, 1000)).toBe(155); // 100 + 30 + 25
  });

  it("diferencia <0.5% suma 70, no 100", () => {
    const inv = { total: 1003, fecha: new Date("2026-06-10T00:00:00Z"), customerRfc: null };
    expect(scoreCandidate(inv, tx, 1000)).toBe(100); // 70 (<0.5%) + 30 (≤1d)
  });
});

describe("isAutoApplicable (umbral exacto, sin cambios)", () => {
  it("exige score ≥ 130", () => {
    expect(AUTO_MATCH_MIN_SCORE).toBe(130);
    expect(isAutoApplicable(129, null)).toBe(false);
    expect(isAutoApplicable(130, null)).toBe(true);
  });

  it("rechaza cuando el 2° candidato está a <20 puntos (ambiguo)", () => {
    expect(AUTO_MATCH_AMBIGUITY_GAP).toBe(20);
    expect(isAutoApplicable(155, 140)).toBe(false); // gap 15 < 20
    expect(isAutoApplicable(155, 135)).toBe(true); // gap 20
  });

  it("aplica cuando no hay 2° candidato y el score alcanza el umbral", () => {
    expect(isAutoApplicable(130, null)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Identidad de la contraparte: lo que convierte "adivinar por monto" en
// "identificar por parte y confirmar por monto".
// ─────────────────────────────────────────────────────────────────────────────

const FECHA = new Date("2026-06-10T00:00:00Z");
const inv = (over: Partial<Parameters<typeof scoreCandidate>[0]> = {}) => ({
  total: 1000,
  fecha: FECHA,
  customerRfc: "ZIO190321JI6",
  ...over,
});

describe("scoreCandidate — RFC extraído del estado de cuenta", () => {
  it("el RFC como CAMPO vale mucho más que el RFC hallado en el texto", () => {
    const conCampo = scoreCandidate(inv(), { ...tx, contraparteRfc: "ZIO190321JI6" }, 1000);
    const enTexto = scoreCandidate(inv(), { ...tx, descripcion: "SPEI ZIO190321JI6 PAGO" }, 1000);
    expect(conCampo).toBe(250); // 100 monto + 30 fecha + 120 RFC exacto
    expect(enTexto).toBe(155); //  100 + 30 + 25
    expect(conCampo).toBeGreaterThan(enTexto);
  });

  it("no suma dos veces cuando el RFC está en el campo Y en el texto", () => {
    const d = { ...tx, descripcion: "SPEI ZIO190321JI6", contraparteRfc: "ZIO190321JI6" };
    expect(scoreCandidate(inv(), d, 1000)).toBe(250);
  });

  it("un RFC que NO empata no suma nada", () => {
    expect(scoreCandidate(inv(), { ...tx, contraparteRfc: "AMA170817NK1" }, 1000)).toBe(130);
  });

  it("LO QUE IMPORTA: el cliente correcto con monto aproximado le gana al equivocado con monto clavado", () => {
    // El caso que hoy se concilia mal: dos facturas del mismo importe la misma
    // semana. Sin identidad, gana la que casualmente clava el monto.
    const correcto = scoreCandidate(
      inv({ total: 1003 }), // 0.3% de diferencia
      { ...tx, contraparteRfc: "ZIO190321JI6" },
      1000,
    );
    const equivocado = scoreCandidate(
      inv({ total: 1000, customerRfc: "AMA170817NK1" }), // monto exacto, otro cliente
      { ...tx, contraparteRfc: "ZIO190321JI6" },
      1000,
    );
    expect(correcto).toBeGreaterThan(equivocado);
    expect(isAutoApplicable(correcto, equivocado)).toBe(true);
  });
});

describe("scoreCandidate — CLABE ya conocida de esa contraparte", () => {
  it("suma 80 cuando la CLABE ya se le vio a este cliente", () => {
    const d = { ...tx, contraparteClabe: "012180015437920135" };
    expect(scoreCandidate(inv({ clabesConocidas: ["012180015437920135"] }), d, 1000)).toBe(210);
  });

  it("una CLABE nunca vista no suma: no es evidencia todavía", () => {
    const d = { ...tx, contraparteClabe: "012180015437920135" };
    expect(scoreCandidate(inv({ clabesConocidas: [] }), d, 1000)).toBe(130);
  });

  it("vale menos que el RFC: identifica la cuenta, no a la persona", () => {
    expect(PUNTOS_CLABE_CONOCIDA).toBeLessThan(PUNTOS_RFC_EXACTO);
  });
});

describe("mismoNombre", () => {
  it("empata ignorando acentos, puntuación y sufijos de razón social", () => {
    expect(mismoNombre("STRIPE PAYMENTS MEXICO S DE RL DE CV", "Stripe Payments México")).toBe(true);
    expect(mismoNombre("CONSTRUCTORA BARTIZ-VERT, S.A. DE C.V.", "Constructora Bartiz Vert")).toBe(true);
  });

  it("NO empata nombres distintos", () => {
    expect(mismoNombre("STRIPE PAYMENTS MEXICO", "GIANT MOTORS LATINOAMERICA")).toBe(false);
  });

  it("exige 6 caracteres: sin ese piso 'SA' empataría con media cartera", () => {
    // Un match de nombre mal dado concilia la factura equivocada, que es más
    // caro que no conciliar.
    expect(mismoNombre("S.A. DE C.V.", "GRUPO S.A. DE C.V.")).toBe(false);
    expect(mismoNombre("ZIONX", "ZIONX SA DE CV")).toBe(false); // "ZIONX" son 5
  });

  it("no truena con nulos", () => {
    expect(mismoNombre(null, "ZIONX SA DE CV")).toBe(false);
    expect(mismoNombre(undefined, undefined)).toBe(false);
  });
});

describe("scoreCandidate — el nombre solo no alcanza", () => {
  it("nombre + fecha, sin monto ni RFC, queda por debajo del umbral", () => {
    const d = { ...tx, contraparteNombre: "CONSTRUCTORA BARTIZ VERT" };
    const s = scoreCandidate(
      inv({ total: 5000, customerNombre: "Constructora Bartiz-Vert, S.A. de C.V." }),
      d,
      1000, // monto muy distinto: no suma
    );
    expect(s).toBe(70); // 30 fecha + 40 nombre
    expect(isAutoApplicable(s, null)).toBe(false);
  });
});
