import { describe, expect, it } from "vitest";
import { validarCatalogoXml, validarPolizasXml, validarBalanzaXml } from "./coe-validador";

const cat = (ctas: string) =>
  `<?xml version="1.0"?><catalogocuentas:Catalogo Version="1.3" RFC="AAA010101AAA" Mes="08" Anio="2026">${ctas}</catalogocuentas:Catalogo>`;

describe("validarCatalogoXml — CodAgrup contra la enum del XSD embarcado", () => {
  it("acepta códigos agrupadores reales del SAT", () => {
    const r = validarCatalogoXml(
      cat(`<catalogocuentas:Ctas CodAgrup="102.01" NumCta="102.01" Desc="Bancos" Nivel="1" Natur="D" />`),
    );
    expect(r.ok).toBe(true);
  });

  it("rechaza el código interno de un plan propio (el bug que rebotaba el archivo)", () => {
    const r = validarCatalogoXml(
      cat(`<catalogocuentas:Ctas CodAgrup="4101-0027" NumCta="4101-0027" Desc="Ventas mostrador" Nivel="2" Natur="A" />`),
    );
    expect(r.ok).toBe(false);
    expect(r.errores[0]).toContain("4101-0027");
    expect(r.errores[0]).toContain("rechazado");
  });

  it("catálogo sin cuentas no pasa", () => {
    expect(validarCatalogoXml(cat("")).ok).toBe(false);
  });
});

const pol = (transacciones: string, id = "1") =>
  `<?xml version="1.0"?><PLZ:Polizas Version="1.3" RFC="AAA010101AAA" Mes="08" Anio="2026" TipoSolicitud="AF"><PLZ:Poliza NumUnIdenPol="${id}" Fecha="2026-08-15" Concepto="x">${transacciones}</PLZ:Poliza></PLZ:Polizas>`;

describe("validarPolizasXml", () => {
  it("acepta una póliza cuadrada con Transferencia válida", () => {
    const r = validarPolizasXml(
      pol(
        `<PLZ:Transaccion NumCta="102.01" Concepto="c" Debe="1000.00" Haber="0.00"><PLZ:Transferencia CtaOri="014180655043289761" BancoOriNal="014" CtaDest="012180001234567895" BancoDestNal="012" Fecha="2026-08-15" Benef="X" RFC="AND010101AB1" Monto="1000.00" /></PLZ:Transaccion>` +
          `<PLZ:Transaccion NumCta="105.01" Concepto="c" Debe="0.00" Haber="1000.00" />`,
      ),
    );
    expect(r.errores).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("caza una póliza descuadrada", () => {
    const r = validarPolizasXml(
      pol(
        `<PLZ:Transaccion NumCta="102.01" Concepto="c" Debe="1000.00" Haber="0.00" />` +
          `<PLZ:Transaccion NumCta="105.01" Concepto="c" Debe="0.00" Haber="999.00" />`,
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.errores[0]).toContain("descuadrada");
  });

  it("caza un banco fuera de c_Banco", () => {
    const r = validarPolizasXml(
      pol(
        `<PLZ:Transaccion NumCta="102.01" Concepto="c" Debe="10.00" Haber="0.00"><PLZ:Transferencia BancoOriNal="001" CtaDest="012180001234567895" BancoDestNal="012" Fecha="2026-08-15" Benef="X" RFC="AND010101AB1" Monto="10.00" /></PLZ:Transaccion>` +
          `<PLZ:Transaccion NumCta="105.01" Concepto="c" Debe="0.00" Haber="10.00" />`,
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.errores.some((e) => e.includes('"001"'))).toBe(true);
  });

  it("caza un RFC mal formado", () => {
    const r = validarPolizasXml(
      pol(
        `<PLZ:Transaccion NumCta="102.01" Concepto="c" Debe="10.00" Haber="0.00"><PLZ:CompNal UUID_CFDI="u" RFC="NO-ES-RFC" MontoTotal="10.00" /></PLZ:Transaccion>` +
          `<PLZ:Transaccion NumCta="105.01" Concepto="c" Debe="0.00" Haber="10.00" />`,
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.errores.some((e) => e.includes("NO-ES-RFC"))).toBe(true);
  });
});

describe("validarBalanzaXml", () => {
  const bal = (ctas: string) =>
    `<?xml version="1.0"?><BCE:Balanza Version="1.3" RFC="AAA010101AAA" Mes="08" Anio="2026" TipoEnvio="N">${ctas}</BCE:Balanza>`;

  it("acepta cifras con dos decimales", () => {
    expect(
      validarBalanzaXml(bal(`<BCE:Ctas NumCta="102.01" SaldoIni="0.00" Debe="10.00" Haber="0.00" SaldoFin="10.00" />`)).ok,
    ).toBe(true);
  });
  it("rechaza balanza vacía", () => {
    expect(validarBalanzaXml(bal("")).ok).toBe(false);
  });
});
