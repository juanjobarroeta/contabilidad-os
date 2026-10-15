import { describe, it, expect } from "vitest";
import { planRetiro, proponerReal, validarArchivoReversion, type Derivado } from "./retiro-derivados";

// ─────────────────────────────────────────────────────────────────────────────
// CENTRO tiene 4,052 insumos que nacieron de los renglones de sus facturas y
// 1,377 del inventario físico. Se retiran los derivados que nada usa; lo que
// una persona tiene que decidir (ambiguo, con existencia, referenciado) se
// queda activo.
// ─────────────────────────────────────────────────────────────────────────────

const CATALOGO = [
  { id: "r1", clave: "MED00123", nombre: "Cefalotina 1 g sol. iny." },
  { id: "r2", clave: "MAT00045", nombre: "Gasa estéril 10x10" },
  { id: "r3", clave: "MAT00046", nombre: "GASA ESTERIL 10X10" }, // nombre duplicado en el Excel
  { id: "r4", clave: "7502009742101", nombre: "Paracetamol 500 mg" },
];

const limpio = (over: Partial<Derivado> = {}): Derivado => ({
  id: "d1",
  clave: "CEFALOTINA 1 G SOL INY",
  nombre: "CEFALOTINA 1 G SOL. INY.",
  lotesConExistencia: 0,
  movimientosNoCfdi: 0,
  referencias: { protocolos: 0, codigosBarras: 0, conteoLineas: 0, lineasArea: 0, cfdiLineas: 0, proveedorClaves: 0 },
  partidas: [],
  ...over,
});

describe("proponerReal", () => {
  it("la clave manda (sin distinguir mayúsculas)", () => {
    expect(proponerReal({ clave: "7502009742101", nombre: "PARACETAMOL TAB" }, "", CATALOGO)).toMatchObject({ propuesto: { id: "r4" }, motivo: "clave" });
  });

  it("sin clave igual, el nombre normalizado del derivado o de la línea", () => {
    expect(proponerReal({ clave: "X", nombre: "CEFALOTINA 1 G SOL. INY." }, "", CATALOGO)).toMatchObject({ propuesto: { id: "r1" }, motivo: "nombre" });
    expect(proponerReal({ clave: "X", nombre: "otro" }, "Cefalotina 1 g sol iny", CATALOGO)).toMatchObject({ propuesto: { id: "r1" }, motivo: "nombre" });
  });

  it("dos insumos físicos con el mismo nombre: ambiguo, no se adivina", () => {
    expect(proponerReal({ clave: "X", nombre: "Gasa esteril 10x10" }, "", CATALOGO)).toMatchObject({ propuesto: null, motivo: "ambiguo", candidatos: 2 });
  });

  it("nada parecido: sin candidato", () => {
    expect(proponerReal({ clave: "X", nombre: "Guantes de nitrilo" }, "Guantes", CATALOGO)).toMatchObject({ propuesto: null, motivo: "sin-candidato" });
  });
});

describe("planRetiro", () => {
  it("un derivado sin uso se desactiva", () => {
    const p = planRetiro([limpio()], CATALOGO);
    expect(p.desactivar.map((d) => d.id)).toEqual(["d1"]);
    expect(p.retenidos).toEqual([]);
  });

  it("con lote con existencia, movimientos propios o referencias se queda, y dice por qué", () => {
    const p = planRetiro(
      [
        limpio({ id: "a", lotesConExistencia: 1 }),
        limpio({ id: "b", movimientosNoCfdi: 3 }),
        limpio({ id: "c", referencias: { protocolos: 1, codigosBarras: 0, conteoLineas: 0, lineasArea: 0, cfdiLineas: 0, proveedorClaves: 0 } }),
        limpio({ id: "d", referencias: { protocolos: 0, codigosBarras: 0, conteoLineas: 0, lineasArea: 2, cfdiLineas: 0, proveedorClaves: 0 } }),
      ],
      CATALOGO
    );
    expect(p.desactivar).toEqual([]);
    expect(Object.fromEntries(p.retenidos.map((r) => [r.id, r.razones]))).toEqual({
      a: ["1 lote(s) con existencia"],
      b: ["3 movimiento(s) que no son del CFDI"],
      c: ["1 protocolos"],
      d: ["2 requisiciones de área"],
    });
  });

  it("la línea de requisición con insumo físico propuesto se remapea y el derivado se desactiva", () => {
    const p = planRetiro([limpio({ partidas: [{ id: "p1", descripcion: "Cefalotina 1g", folio: "REQ-7" }] })], CATALOGO);
    expect(p.remapeos).toMatchObject([{ partidaId: "p1", derivadoId: "d1", propuesto: { id: "r1" }, motivo: "nombre", folio: "REQ-7" }]);
    expect(p.desactivar.map((d) => d.id)).toEqual(["d1"]);
    expect(p.conteos).toMatchObject({ partidas: 1, remapeables: 1, desactivar: 1, retenidos: 0 });
  });

  it("línea ambigua: no se remapea y el derivado se queda activo (sigue referenciado)", () => {
    const p = planRetiro([limpio({ id: "g", clave: "GASA", nombre: "GASA ESTERIL 10X10", partidas: [{ id: "p2", descripcion: "gasa" }] })], CATALOGO);
    expect(p.remapeos[0]).toMatchObject({ propuesto: null, motivo: "ambiguo" });
    expect(p.desactivar).toEqual([]);
    expect(p.retenidos[0].razones).toEqual(["1 línea(s) de requisición sin insumo físico que la reciba"]);
    expect(p.conteos).toMatchObject({ ambiguas: 1, remapeables: 0 });
  });
});

describe("validarArchivoReversion", () => {
  it("acepta lo que escribe --apply y rechaza otra cosa", () => {
    const ok = { version: 1, companyId: "c", rfc: "CPM2307076Z9", aplicadoAt: "x", remapeos: [{ partidaId: "p", de: "d", a: "r" }], desactivados: ["d"] };
    expect(validarArchivoReversion(ok)).toEqual(ok);
    expect(() => validarArchivoReversion({ ...ok, version: 2 })).toThrow();
    expect(() => validarArchivoReversion({ ...ok, remapeos: [{ partidaId: "p" }] })).toThrow();
    expect(() => validarArchivoReversion(null)).toThrow();
  });
});
