import { describe, it, expect } from "vitest";
import {
  clasificarPuesto,
  derivarNominaCostoSiAplica,
  estimarCuotasPatronales,
  extraerNominaCfdi,
} from "./auto-nomina";

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

// Recibo con los DOS nodos «Receptor» que trae un CFDI de nómina real: el del
// comprobante (empleado) y el del complemento (puesto y base de cotización).
const RECIBO = `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" TipoDeComprobante="N" SubTotal="12000.00" Total="10250.00">
  <cfdi:Receptor Rfc="gome850312hd4" Nombre="GONZALEZ MENDEZ JOSE" UsoCFDI="CN01"/>
  <cfdi:Complemento>
    <nomina12:Nomina xmlns:nomina12="http://www.sat.gob.mx/nomina12" Version="1.2" TipoNomina="O" FechaPago="2026-07-15" NumDiasPagados="15">
      <nomina12:Receptor Curp="XAXX010101HDFRRR00" NumSeguridadSocial="12345678901" TipoContrato="01" TipoRegimen="02" NumEmpleado="42" Departamento="TEHUACAN" Puesto="TECNICO" RiesgoPuesto="2" PeriodicidadPago="04" SalarioBaseCotApor="400.00" SalarioDiarioIntegrado="420.00"/>
      <nomina12:Percepciones TotalSueldos="11000.00" TotalGravado="10000.00" TotalExento="2000.00"/>
    </nomina12:Nomina>
  </cfdi:Complemento>
</cfdi:Comprobante>`;

describe("extraerNominaCfdi()", () => {
  it("lee puesto, sucursal y percepciones BRUTAS (no el neto depositado)", () => {
    const d = extraerNominaCfdi(RECIBO, 12000);
    expect(d).toMatchObject({ esNomina: true, puesto: "TECNICO", sucursal: "TEHUACAN" });
    // El puesto vive en el Receptor del COMPLEMENTO y el nombre en el del
    // COMPROBANTE: si se lee el primer «Receptor» a ciegas, el puesto queda
    // vacío y toda la nómina se clasifica como ADMIN.
    expect(d.empleado).toBe("GONZALEZ MENDEZ JOSE");
    expect(d.rfcEmpleado).toBe("gome850312hd4");
    expect(d.percepciones).toBe(12000); // gravado + exento, no el Total de 10,250
    // La base para estimar el costo patronal SÍ viene en el recibo.
    expect(d.sbcDiario).toBe(400);
    expect(d.diasPagados).toBe(15);
    expect(d.riesgoPuesto).toBe("2");
  });

  it("sin totales en el complemento cae al SubTotal del comprobante", () => {
    const sinTotales = RECIBO.replace(/<nomina12:Percepciones[^>]*\/>/, "");
    expect(extraerNominaCfdi(sinTotales, 9500).percepciones).toBe(9500);
  });
});

describe("estimarCuotasPatronales()", () => {
  it("reconstruye el costo patronal que el CFDI NO declara (IMSS + 5% INFONAVIT)", () => {
    const d = extraerNominaCfdi(RECIBO, 12000);
    const cuotas = estimarCuotasPatronales(d, new Date("2026-07-15T00:00:00Z"));
    // SBC 400 × 15 días = 6,000 de base. El patronal ronda 25-30% de la base;
    // el INFONAVIT solo ya son 300. Se acota el rango en vez de fijar el
    // centavo: las tasas cambian por ejercicio (CEAV es progresiva).
    expect(cuotas).toBeGreaterThan(1000);
    expect(cuotas).toBeLessThan(2500);
  });

  it("sin SBC en el recibo no inventa un costo", () => {
    const sinSbc = { esNomina: true, puesto: "TECNICO", sucursal: null, empleado: null, rfcEmpleado: null, percepciones: 1000, sbcDiario: null, diasPagados: 15, riesgoPuesto: "1" };
    expect(estimarCuotasPatronales(sinSbc, new Date("2026-07-15T00:00:00Z"))).toBe(0);
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
      empleado: "GONZALEZ MENDEZ JOSE", rfcEmpleado: "GOME850312HD4",
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

describe("extraerNominaCfdi() — SBC cuando el emisor no manda SalarioBaseCotApor", () => {
  const recibo = (attrsReceptor: string) => `<?xml version="1.0"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Total="10000">
  <cfdi:Receptor Rfc="XAXX010101000" Nombre="JUAN PEREZ"/>
  <cfdi:Complemento>
    <nomina12:Nomina xmlns:nomina12="http://www.sat.gob.mx/nomina12" NumDiasPagados="15" TotalPercepciones="10000">
      <nomina12:Receptor ${attrsReceptor}/>
      <nomina12:Percepciones TotalGravado="10000" TotalExento="0"/>
    </nomina12:Nomina>
  </cfdi:Complemento>
</cfdi:Comprobante>`;

  it("usa SalarioDiarioIntegrado cuando falta SalarioBaseCotApor", () => {
    // Caso real de Margom: 0 de 4,494 recibos traen SalarioBaseCotApor y los
    // 4,494 traen SalarioDiarioIntegrado. Sin respaldo, las cuotas patronales
    // de toda la plantilla salían en cero.
    const d = extraerNominaCfdi(recibo('Puesto="TECNICO" Departamento="TALLER" SalarioDiarioIntegrado="450.75"'));
    expect(d.sbcDiario).toBe(450.75);
    expect(d.diasPagados).toBe(15);
  });

  it("prefiere SalarioBaseCotApor cuando sí viene: es el valor declarado al IMSS", () => {
    const d = extraerNominaCfdi(
      recibo('Puesto="TECNICO" SalarioBaseCotApor="400.00" SalarioDiarioIntegrado="450.75"')
    );
    expect(d.sbcDiario).toBe(400);
  });

  it("sin ninguno de los dos, no se inventa un salario", () => {
    const d = extraerNominaCfdi(recibo('Puesto="TECNICO"'));
    expect(d.sbcDiario).toBeNull();
  });
});
