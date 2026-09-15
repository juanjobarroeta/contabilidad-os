import { describe, it, expect } from "vitest";
import { clasificarCfdi, MONTO_REVISION_INVERSION } from "./clasificar-cfdi";
import { TASA_DEPRECIACION, tipoActivoDesdeSubtipo } from "./depreciacion";

const egreso = (usoCfdi: string, items: Array<{ claveProdServ: string; importe: number }> = []) =>
  clasificarCfdi({ tipo: "EGRESO", usoCfdi, items });

const CARO = [{ claveProdServ: "43211500", importe: 80000 }]; // servidor

describe("clasificarCfdi() — inversiones", () => {
  it("I04 con equipo de cómputo: inversión, sin bandera", () => {
    const c = egreso("I04", CARO);
    expect(c.naturaleza).toBe("INVERSION");
    expect(c.subtipoInversion).toBe("computo");
    expect(c.requiereRevision).toBe(false);
  });

  // Lo que el usuario vio: una licencia de software en la lista de depreciación.
  it("software facturado como inversión es INTANGIBLE, no equipo de cómputo", () => {
    const c = egreso("I04", [{ claveProdServ: "43231500", importe: 40000 }]);
    expect(c.subtipoInversion).toBe("intangible");
    expect(c.fundamento).toContain("Art. 33");
    expect(c.requiereRevision).toBe(true);
    expect(c.motivoRevision).toContain("AMORTIZA");
    // Y la tasa que le toca es la de amortización, no el 30 % de cómputo.
    expect(TASA_DEPRECIACION[tipoActivoDesdeSubtipo(c.subtipoInversion)].tasa).toBe(0.15);
    expect(TASA_DEPRECIACION.computo.tasa).toBe(0.3);
  });

  // Y el USB: no se excluye solo —la LISR no tiene monto mínimo— pero se marca.
  it("un importe chico bajo uso de inversión se marca para revisión", () => {
    const c = egreso("I04", [{ claveProdServ: "43211500", importe: 120 }]);
    expect(c.naturaleza).toBe("INVERSION");
    expect(c.requiereRevision).toBe(true);
    expect(c.motivoRevision).toContain("consumible");
    expect(egreso("I04", [{ claveProdServ: "43211500", importe: MONTO_REVISION_INVERSION }]).requiereRevision).toBe(false);
  });

  it("el guardia del otro lado sigue igual: G03 con clave de activo se marca", () => {
    const c = egreso("G03", [{ claveProdServ: "25101500", importe: 300000 }]);
    expect(c.naturaleza).toBe("GASTO");
    expect(c.requiereRevision).toBe(true);
  });

  it("transporte sigue distinguiendo pasajeros (tope) de carga", () => {
    expect(egreso("I03", [{ claveProdServ: "25101500", importe: 400000 }]).posibleTopeAutomovil).toBe(true);
    expect(egreso("I03", [{ claveProdServ: "25101800", importe: 400000 }]).posibleTopeAutomovil).toBe(false);
    expect(egreso("I03", CARO).requiereRevision).toBe(true);
  });

  it("lo demás no cambia: G01 inventario, S01 sin efectos", () => {
    expect(egreso("G01").naturaleza).toBe("INVENTARIO");
    expect(egreso("S01").naturaleza).toBe("SIN_EFECTOS");
    expect(clasificarCfdi({ tipo: "INGRESO", usoCfdi: "I04", items: CARO }).fuente).toBe("no_aplica");
  });
});
