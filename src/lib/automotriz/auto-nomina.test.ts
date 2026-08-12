import { describe, it, expect } from "vitest";
import { clasificarPuesto, derivarNominaCostoSiAplica, extraerNominaCfdi } from "./auto-nomina";

// Puestos REALES del roster de Margom (los que salieron del archivo de nómina).
describe("clasificarPuesto() — puestos reales de la agencia", () => {
  it("producción del taller", () => {
    for (const p of ["TECNICO", "LAVADOR", "ASESOR DE SERV", "HOJALATERO", "PINTOR", "JEFE DE TALLER"]) {
      expect(clasificarPuesto(p)).toBe("TALLER");
    }
  });

  it("mostrador y almacén de partes", () => {
    for (const p of ["REFACCIONARIA", "MOSTRADOR", "ALMACENISTA"]) {
      expect(clasificarPuesto(p)).toBe("REFACCIONES");
    }
  });

  it("piso de ventas", () => {
    for (const p of ["VENDEDOR", "GERENTE DE VENTAS", "ASESOR COMERCIAL", "F&I"]) {
      expect(clasificarPuesto(p)).toBe("VENTAS");
    }
  });

  it("estructura: lo que no se puede probar que produce es ADMIN", () => {
    for (const p of ["AUXILIAR DE CONTABILIDAD", "RECEPCIONISTA", "DIRECTOR GENERAL", "", null]) {
      expect(clasificarPuesto(p)).toBe("ADMIN");
    }
  });

  it("«asesor de servicio» es taller, no ventas", () => {
    expect(clasificarPuesto("ASESOR DE SERVICIO")).toBe("TALLER");
    expect(clasificarPuesto("ASESOR DE SERV")).toBe("TALLER");
  });
});

const RECIBO = `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" TipoDeComprobante="N" SubTotal="12000.00" Total="10250.00">
  <cfdi:Complemento>
    <nomina12:Nomina xmlns:nomina12="http://www.sat.gob.mx/nomina12" Version="1.2" TipoNomina="O" FechaPago="2026-07-15">
      <nomina12:Receptor Curp="XAXX010101HDFRRR00" NumSeguridadSocial="12345678901" TipoContrato="01" TipoRegimen="02" NumEmpleado="42" Departamento="TEHUACAN" Puesto="TECNICO" RiesgoPuesto="2" PeriodicidadPago="04" SalarioBaseCotApor="400.00" SalarioDiarioIntegrado="420.00"/>
      <nomina12:Percepciones TotalSueldos="11000.00" TotalGravado="10000.00" TotalExento="2000.00"/>
    </nomina12:Nomina>
  </cfdi:Complemento>
</cfdi:Comprobante>`;

describe("extraerNominaCfdi()", () => {
  it("lee puesto, sucursal y percepciones BRUTAS (no el neto depositado)", () => {
    const d = extraerNominaCfdi(RECIBO, 12000);
    expect(d).toMatchObject({ esNomina: true, puesto: "TECNICO", sucursal: "TEHUACAN" });
    expect(d.percepciones).toBe(12000); // gravado + exento, no el Total de 10,250
  });

  it("sin totales en el complemento cae al SubTotal del comprobante", () => {
    const sinTotales = RECIBO.replace(/<nomina12:Percepciones[^>]*\/>/, "");
    expect(extraerNominaCfdi(sinTotales, 9500).percepciones).toBe(9500);
  });
});

function fakeDb() {
  const filas: Array<Record<string, unknown>> = [];
  return {
    _filas: filas,
    nominaCosto: {
      findUnique: async ({ where }: never) =>
        filas.find((f) => f.invoiceId === (where as { invoiceId: string }).invoiceId) ?? null,
      create: async ({ data }: never) => {
        filas.push({ ...(data as Record<string, unknown>) });
        return data;
      },
    },
  };
}

describe("derivarNominaCostoSiAplica()", () => {
  const base = { companyId: "c1", fecha: new Date("2026-07-15T00:00:00Z"), subtotal: 12000 };

  it("crea el costo clasificado y es idempotente", async () => {
    const db = fakeDb();
    expect(
      await derivarNominaCostoSiAplica(db as never, { ...base, invoiceId: "n1", tipo: "NOMINA", rawXml: RECIBO })
    ).toBe(true);
    expect(db._filas[0]).toMatchObject({
      invoiceId: "n1", sucursal: "TEHUACAN", puesto: "TECNICO", linea: "TALLER", percepciones: 12000,
    });
    expect(
      await derivarNominaCostoSiAplica(db as never, { ...base, invoiceId: "n1", tipo: "NOMINA", rawXml: RECIBO })
    ).toBe(false);
    expect(db._filas).toHaveLength(1);
  });

  it("un CFDI que no es nómina no aplica", async () => {
    const db = fakeDb();
    expect(
      await derivarNominaCostoSiAplica(db as never, { ...base, invoiceId: "i1", tipo: "INGRESO", rawXml: RECIBO })
    ).toBe(false);
  });
});
