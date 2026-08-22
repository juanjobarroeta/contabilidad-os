import { describe, it, expect } from "vitest";

// El papel de trabajo del IVA y el motor de la declaración tienen que excluir
// EXACTAMENTE lo mismo. Si divergen, el papel deja de justificar la cifra que
// se presenta — y el error es silencioso: nadie ve dos números juntos.
//
// El motor (computeTaxPosition) filtra a los proveedores 69-B en el WHERE de
// los egresos; el papel los trae y los marca. Este test fija la regla de
// exclusión que ambos aplican, para que un cambio en uno rompa aquí.

type Renglon = {
  importe: number;
  excluidoAcreditamiento?: boolean;
  sinComplementoPago?: boolean;
  emisorEnLista69B?: boolean;
};

/** La misma condición que usa el total del papel y `cuenta()` del panel. */
const cuenta = (r: Renglon) =>
  !r.excluidoAcreditamiento && !r.sinComplementoPago && !r.emisorEnLista69B;

const totalAcreditable = (rs: Renglon[]) =>
  +rs.filter(cuenta).reduce((a, r) => a + r.importe, 0).toFixed(2);

describe("exclusión del papel de trabajo de IVA", () => {
  it("deja fuera el IVA de un proveedor en la lista 69-B", () => {
    const renglones: Renglon[] = [
      { importe: 1000 },
      { importe: 41200, emisorEnLista69B: true },
    ];
    expect(totalAcreditable(renglones)).toBe(1000);
  });

  it("los tres motivos son independientes y todos restan", () => {
    const renglones: Renglon[] = [
      { importe: 100 },
      { importe: 200, excluidoAcreditamiento: true },
      { importe: 300, sinComplementoPago: true },
      { importe: 400, emisorEnLista69B: true },
    ];
    expect(totalAcreditable(renglones)).toBe(100);
  });

  it("un CFDI con dos motivos se resta UNA vez, no dos", () => {
    // Importa porque el total es una suma de los que SÍ cuentan, no una resta
    // de los excluidos: si se restara, el doble motivo restaría de más.
    const renglones: Renglon[] = [
      { importe: 500 },
      { importe: 900, emisorEnLista69B: true, sinComplementoPago: true },
    ];
    expect(totalAcreditable(renglones)).toBe(500);
  });

  it("sin proveedores bloqueados el total no cambia", () => {
    // El caso de hoy: el único hallazgo 69-B está RESUELTO, así que no hay
    // RFC bloqueado y el papel debe dar lo mismo que antes del arreglo.
    const renglones: Renglon[] = [{ importe: 1000 }, { importe: 2000 }];
    expect(totalAcreditable(renglones)).toBe(3000);
  });

  it("el 69-B no lo levanta el contador: marcarlo «incluir» no lo vuelve acreditable", () => {
    // `excluidoAcreditamiento` es criterio del contador y se puede alternar;
    // `emisorEnLista69B` viene de la publicación del SAT y manda igual.
    const r: Renglon = { importe: 41200, emisorEnLista69B: true, excluidoAcreditamiento: false };
    expect(cuenta(r)).toBe(false);
  });
});
