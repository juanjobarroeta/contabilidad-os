import { describe, expect, it } from "vitest";
import { esEstadoBbva, leerEstadoBbva, resolverTramo } from "./bbva-texto";
import { corregirAnios } from "./periodo-declarado";

// Un estado BBVA sintético con la forma exacta del texto del PDF: dos días,
// un «PAGO CUENTA DE TERCERO» que puede ser cargo o abono (lo decide el saldo
// impreso), una continuación partida por salto de página.
const estado = (abonos = "1,250.00", conteoAbonos = 2) => `CENTRO DE PRUEBA SA DE CV
Periodo DEL 01/03/2026 AL 31/03/2026
No. de Cuenta 0120809012
Comportamiento
Saldo de Liquidación Inicial 1,000.00
Saldo de Operación Inicial 1,000.00
Depósitos / Abonos (+) 2 1,250.00
Retiros / Cargos (-) 2 450.00
Saldo Final (+) 1,800.00
Saldo de Operación Final 1,800.00
Detalle de Movimientos Realizados
FECHA SALDO
OPER LIQ COD. DESCRIPCIÓN REFERENCIA CARGOS ABONOS OPERACIÓN LIQUIDACIÓN
02/MAR 02/MAR T20 SPEI RECIBIDOBANORTE 1,000.00
0020326PAGO PACIENTE Ref. 0109550296 072
02/MAR 02/MAR T17 SPEI ENVIADO SANTANDER 400.00 1,600.00 1,600.00
0020326FACTURA 12 Ref. 0030487744 014
DOMICILIO FISCAL
CALLE 1
COLONIA
PUEBLA CP 72000

-- 1 of 2 --

No. Cuenta 0120809012
PAGINA 2 / 2
MAESTRA PYME BBVA
FECHA SALDO
OPER LIQ COD. DESCRIPCIÓN REFERENCIA CARGOS ABONOS OPERACIÓN LIQUIDACIÓN
JUAN PEREZ
03/MAR 03/MAR N06 PAGO CUENTA DE TERCERO 250.00
BNET 0456126626 CLIENTE Ref. 0073551291
03/MAR 03/MAR S39 SERV BANCA INTERNET 50.00 1,800.00 1,800.00
Ref. SERV BCA INTERN
Total de Movimientos
TOTAL IMPORTE CARGOS 450.00 TOTAL MOVIMIENTOS CARGOS 2
TOTAL IMPORTE ABONOS ${abonos} TOTAL MOVIMIENTOS ABONOS ${conteoAbonos}
BBVA MEXICO, S.A., INSTITUCION DE BANCA MULTIPLE
`;
const periodo = { inicio: "2026-03-01", fin: "2026-03-31" };

describe("leerEstadoBbva", () => {
  it("reconoce el formato", () => expect(esEstadoBbva(estado())).toBe(true));

  it("lee los renglones, deduce el signo ambiguo por el saldo y empata con lo declarado", () => {
    const r = leerEstadoBbva(estado(), periodo);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.lectura.movimientos;
    expect(m.map((x) => [x.fecha, x.codigo, x.monto])).toEqual([
      ["2026-03-02", "T20", 1000], ["2026-03-02", "T17", -400], ["2026-03-03", "N06", 250], ["2026-03-03", "S39", -50],
    ]);
    expect(m[2].pagina).toBe(2);
    // El nombre que abre la página 2 es la continuación del renglón anterior; el domicilio fiscal no.
    expect(m[1].sublineas).toEqual(["0020326FACTURA 12 Ref. 0030487744 014", "JUAN PEREZ"]);
    expect(m[0].referencia).toBe("0109550296 072");
    expect(r.lectura.volteados).toBe(0);
  });

  it("si lo leído no empata con los totales del banco, no se usa", () => {
    const r = leerEstadoBbva(estado("1,300.00"), periodo);
    expect(r.ok).toBe(false);
  });
  it("si el conteo declarado no coincide con los renglones leídos, no se usa", () => {
    expect(leerEstadoBbva(estado("1,250.00", 3), periodo).ok).toBe(false);
  });
});

describe("resolverTramo", () => {
  it("decide los ambiguos para cuadrar el saldo del día", () => {
    expect(resolverTramo([{ abs: 1000, signo: 1 }, { abs: 300, signo: 0 }], 700)).toEqual([1, -1]);
  });
  it("voltea la propuesta mínima si hace falta", () => {
    expect(resolverTramo([{ abs: 500, signo: -1 }, { abs: 200, signo: -1 }], 300)).toEqual([1, -1]);
  });
  it("sin solución, null", () => {
    expect(resolverTramo([{ abs: 500, signo: -1 }], 123)).toBeNull();
  });
});

describe("corregirAnios", () => {
  it("lleva al año del periodo los renglones con año inventado", () => {
    const tx = [{ fecha: new Date("2019-03-18T12:00:00") }, { fecha: new Date("2026-03-20T12:00:00") }, { fecha: new Date("2025-07-01T12:00:00") }];
    expect(corregirAnios(tx, periodo)).toBe(1);
    expect(tx.map((t) => t.fecha.toISOString().slice(0, 10))).toEqual(["2026-03-18", "2026-03-20", "2025-07-01"]);
  });
});
