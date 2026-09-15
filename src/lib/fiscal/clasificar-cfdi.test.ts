import { describe, it, expect } from "vitest";
import { clasificarCfdi, partirInversionPorConcepto, MONTO_REVISION_INVERSION } from "./clasificar-cfdi";
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

// Una factura con laptop, licencia y memoria quedaba como UN activo llamado
// «Laptop» por el total, depreciándose todo al 30 %.
describe("partirInversionPorConcepto()", () => {
  const laptop = { claveProdServ: "43211503", importe: 30000, descripcion: "Laptop Dell" };
  const licencia = { claveProdServ: "43231500", importe: 12000, descripcion: "Licencia Office 365" };
  const flete = { claveProdServ: "78101800", importe: 1000, descripcion: "Flete" };

  it("un solo tratamiento: un activo por el subtotal entero, como siempre", () => {
    const g = partirInversionPorConcepto("computo", [laptop], 30000);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ subtipo: "computo", importe: 30000, descripcion: "Laptop Dell" });
  });

  it("laptop y licencia se separan, cada una con su tratamiento", () => {
    const g = partirInversionPorConcepto("computo", [laptop, licencia], 42000);
    expect(g.map((x) => [x.subtipo, x.importe])).toEqual([
      ["computo", 30000],
      ["intangible", 12000],
    ]);
    expect(g.find((x) => x.subtipo === "intangible")?.requiereRevision).toBe(true);
  });

  // Art. 31: el monto original incluye fletes, seguros e instalación. Un flete
  // NO es un activo suelto llamado «Flete».
  it("lo accesorio se va con el grupo más grande, no se vuelve un activo", () => {
    const g = partirInversionPorConcepto("computo", [laptop, licencia, flete], 43000);
    expect(g).toHaveLength(2);
    expect(g[0]).toMatchObject({ subtipo: "computo", importe: 31000 });
    expect(g[1]).toMatchObject({ subtipo: "intangible", importe: 12000 });
    expect(g.reduce((s, x) => s + x.importe, 0)).toBe(43000);
  });

  it("los grupos siempre suman el subtotal del CFDI, centavos incluidos", () => {
    const g = partirInversionPorConcepto("computo", [laptop, licencia], 41999.99);
    // Cada grupo es exacto al centavo; la suma se compara redondeada, que es
    // como la compara el motor de pólizas (la binaria arrastra 5e-12).
    expect(Math.round(g.reduce((s, x) => s + x.importe, 0) * 100) / 100).toBe(41999.99);
    expect(g.map((x) => x.importe)).toEqual([29999.99, 12000]);
  });

  it("sin claves que digan nada, manda el usoCfdi", () => {
    const g = partirInversionPorConcepto("mobiliario", [{ claveProdServ: "99999999", importe: 9000 }], 9000);
    expect(g).toEqual([expect.objectContaining({ subtipo: "mobiliario", importe: 9000 })]);
  });

  it("el nombre sale del renglón mayor, y dice cuántos lo acompañan", () => {
    const g = partirInversionPorConcepto("computo", [laptop, { ...licencia, claveProdServ: "43211500", importe: 500, descripcion: "Mouse" }], 30500);
    expect(g[0].descripcion).toBe("Laptop Dell y 1 concepto(s) más");
  });
});
