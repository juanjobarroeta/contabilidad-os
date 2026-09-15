import { describe, it, expect } from "vitest";
import { CLAVES_MOTOR, MAPA_DEFAULT, claveDeCostoFarmacia } from "./contabilidad";
import { normalizar, sugerirCuenta, type CuentaCandidata } from "./sugerir-mapa";
import { CATALOGO_REAL } from "./__fixtures__/catalogo-centro";

/** La propuesta para una clave contra el catálogo real, por su agrupador. */
const proponer = (clave: (typeof CLAVES_MOTOR)[number]) => {
  const codigo = MAPA_DEFAULT[clave].cuentaSAT;
  return sugerirCuenta(clave, CATALOGO_REAL[codigo] ?? [], codigo);
};

describe("normalizar()", () => {
  it("sin acentos, sin signos, en minúsculas", () => {
    expect(normalizar("Almacén Farmacia 16%")).toBe("almacen farmacia 16");
    expect(normalizar("Imagenología")).toBe("imagenologia");
    expect(normalizar("  Central De Esterilización y Equipos (CEYE) ")).toBe("central de esterilizacion y equipos ceye");
  });
});

// El caso que motivó todo esto: 28 cuentas con agrupador 401.01, 33 con 501.01
// y 29 con 115.01, una por servicio. La cola del hub pedía elegir UNA.
describe("el catálogo real de un hospital", () => {
  it("el servicio de la clave se lee en el nombre: propuesta única y aplicable", () => {
    const esperado: Record<string, string> = {
      INGRESO_HOSPITALIZACION: "401002002",
      INGRESO_QUIROFANO: "401002004",
      INGRESO_URGENCIAS: "401008001",
      INGRESO_FARMACIA_16: "401001002",
      INGRESO_FARMACIA_0: "401005001",
      INVENTARIO_FARMACIA: "115001006",
      RETENCION_ISR_HONORARIOS: "216004000",
      RETENCION_IVA_HONORARIOS: "216010000",
    };
    for (const [clave, codigo] of Object.entries(esperado)) {
      const s = proponer(clave as (typeof CLAVES_MOTOR)[number]);
      expect(s?.confianza, clave).toBe("EXACTA");
      expect(s?.cuenta.codigo, clave).toBe(codigo);
    }
  });

  // Lo que el usuario señaló: el costo de farmacia no es uno, son dos, y cada
  // uno va del lado de la tasa con la que se facturó.
  it("el costo de farmacia sigue a la tasa: 16 % al almacén interno, 0 % a la externa", () => {
    expect(proponer("COSTO_FARMACIA_16")).toMatchObject({ confianza: "EXACTA", cuenta: { codigo: "501001002", nombre: "Farmacia 16%" } });
    expect(proponer("COSTO_FARMACIA_0")).toMatchObject({ confianza: "EXACTA", cuenta: { codigo: "501005001", nombre: "Farmacia 0%" } });
    // Y la clave que elige cada uno es la misma regla del ingreso.
    expect(claveDeCostoFarmacia({ ivaContexto: "SUMINISTRO_HOSPITALARIO", ivaTasa: 0 })).toBe("COSTO_FARMACIA_16");
    expect(claveDeCostoFarmacia({ ivaContexto: "VENTA_DIRECTA", ivaTasa: 0 })).toBe("COSTO_FARMACIA_0");
  });

  it("la cuenta espejo «…Pendiente de pago» no gana, ni cortada a 50 caracteres", () => {
    const s = proponer("RETENCION_ISR_HONORARIOS");
    expect(s?.cuenta.codigo).toBe("216004000");
    expect(s?.alternativas[0]?.codigo).toBe("216016000");
  });

  it("lo que es criterio no se aplica solo: queda PARECIDA con sus alternativas", () => {
    // Laboratorio e imagen son dos cuentas y la clave de estudios es una.
    const estudios = proponer("INGRESO_ESTUDIOS");
    expect(estudios?.confianza).toBe("PARECIDA");
    expect(estudios?.alternativas.length).toBeGreaterThan(0);
    // Ningún nombre dice en qué caja entra el efectivo del hospital.
    expect(proponer("CAJA")?.confianza).toBe("PARECIDA");
  });

  it("lo que el nombre no puede decir se queda sin propuesta", () => {
    // 23 auxiliares de clientes —pacientes, aseguradoras, la cafetería—: cuál
    // recibe la cuenta por cobrar del paciente no lo dice ningún nombre.
    expect(proponer("CLIENTES")).toBeNull();
    // Y las 11 cuentas bancarias del catálogo ya ni se preguntan: BANCOS salió
    // de las claves porque el módulo no postea contra bancos.
    expect(CATALOGO_REAL["102.01"].length).toBeGreaterThan(1);
    expect((CLAVES_MOTOR as readonly string[]).includes("BANCOS")).toBe(false);
  });
});

describe("sugerirCuenta()", () => {
  const cta = (id: string, nombre: string, padre?: string): CuentaCandidata => ({ id, codigo: id, nombre, padre: padre ?? null });

  it("sin candidatas, con una sola, o sin pistas: no propone", () => {
    expect(sugerirCuenta("INGRESO_QUIROFANO", [], "401.01")).toBeNull();
    // CLIENTES no tiene pistas: ningún nombre dice cuál auxiliar es el paciente.
    expect(sugerirCuenta("CLIENTES", [cta("1", "Plan Seguro"), cta("2", "Vitamedica")], "105.01")).toBeNull();
  });

  it("empate = el nombre no distingue: mejor ninguna propuesta que una al azar", () => {
    const empate = sugerirCuenta("INGRESO_URGENCIAS", [cta("1", "Urgencias"), cta("2", "Urgencias")], "401.01");
    expect(empate).toBeNull();
  });

  it("el padre cuenta menos que el nombre, pero cuenta", () => {
    const s = sugerirCuenta("INGRESO_FARMACIA_16", [cta("1", "Farmacia 16%", "Farmacia Externa"), cta("2", "Farmacia 16%", "Farmacia Hospitalaria")], "401.01");
    expect(s?.cuenta.id).toBe("2");
  });

  it("explica la propuesta en una línea, con el agrupador y cuántas candidatas había", () => {
    const s = proponer("INVENTARIO_FARMACIA");
    expect(s?.porque).toContain("115.01");
    expect(s?.porque).toContain("29");
  });
});
