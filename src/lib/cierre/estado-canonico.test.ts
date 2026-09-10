import { describe, expect, it } from "vitest";
import { resolverEstadoCierre, type EstadoContableCierre, type PasoParaEstadoCierre } from "./estado-canonico";

function paso(over: Partial<PasoParaEstadoCierre> = {}): PasoParaEstadoCierre {
  return {
    clave: "banco",
    titulo: "Bancos",
    estadoCalculado: "listo",
    estado: "PENDIENTE",
    detalle: null,
    senales: [],
    ...over,
  };
}

function resolver(
  estadoContable: EstadoContableCierre | null,
  pasos: PasoParaEstadoCierre[],
  declaracionExterna = false
) {
  return resolverEstadoCierre({ estadoContable, pasos, declaracionExterna });
}

const presentada = paso({
  clave: "declaracion",
  titulo: "Declaración",
  senales: [{ clave: "fx:declaracion-periodo", estado: "ok", resumen: "Presentada" }],
});

describe("resolverEstadoCierre", () => {
  it("avanza LISTO → CONTABILIZADO → CERRADO desde una sola fuente", () => {
    expect(resolver("DRAFT", [paso()])).toMatchObject({
      fase: "LISTO",
      listo: true,
      contabilizado: false,
      cerrado: false,
      descargable: false,
      puedeContabilizar: true,
    });
    expect(resolver("POSTED", [paso()])).toMatchObject({
      fase: "CONTABILIZADO",
      contabilizado: true,
      cerrado: false,
      descargable: true,
    });
    expect(resolver("POSTED", [paso(), presentada])).toMatchObject({
      fase: "CERRADO",
      declarado: true,
      contabilizado: true,
      cerrado: true,
      descargable: true,
    });
    expect(resolver("CLOSED", [paso()])).toMatchObject({ fase: "CERRADO", cerrado: true });
  });

  it("un bloqueo del motor manda incluso sobre CLOSED y declaración presentada", () => {
    const r = resolver("CLOSED", [
      paso({ estadoCalculado: "bloquea", detalle: "43 movimientos sin clasificar" }),
      presentada,
    ]);
    expect(r).toMatchObject({
      fase: "BLOQUEADO",
      estadoContable: "CLOSED",
      declarado: true,
      listo: false,
      contabilizado: false,
      cerrado: false,
      descargable: false,
      puedeContabilizar: false,
    });
    expect(r.bloqueos).toEqual([
      expect.objectContaining({ paso: "banco", tipo: "MOTOR", detalle: "43 movimientos sin clasificar" }),
    ]);
  });

  it("falla cerrado cuando faltan datos o cambió evidencia confirmada", () => {
    expect(resolver("POSTED", [paso({ estadoCalculado: "sin_datos" })]).bloqueos[0].tipo).toBe("SIN_DATOS");
    expect(resolver("POSTED", [paso({ estado: "REVISAR" })]).bloqueos[0].tipo).toBe("EVIDENCIA_CAMBIO");
  });

  it("una espera huérfana no se convierte en LISTO", () => {
    const r = resolver("DRAFT", [paso({ estadoCalculado: "espera" })]);
    expect(r.fase).toBe("BLOQUEADO");
    expect(r.bloqueos[0].tipo).toBe("DEPENDENCIA");
  });

  it("la atención no es un bloqueo duro", () => {
    const r = resolver("POSTED", [paso({ estadoCalculado: "atencion", detalle: "Revisar un aviso" })]);
    expect(r).toMatchObject({ fase: "CONTABILIZADO", listo: true, descargable: true });
    expect(r.bloqueos).toEqual([]);
  });

  it("una declaración histórica cierra fuera de ContabilidadOS sin inventar pólizas ni paquete", () => {
    const r = resolver("DRAFT", [paso({ estadoCalculado: "sin_datos" })], true);
    expect(r).toMatchObject({
      fase: "CERRADO",
      declarado: true,
      origenCierre: "FUERA_DE_CONTABILIDAD_OS",
      listo: false,
      contabilizado: false,
      cerrado: true,
      descargable: false,
      puedeContabilizar: false,
    });
    expect(r.bloqueos).toHaveLength(1);
  });

  it("conserva el origen externo aunque después se reconstruya el libro local", () => {
    const r = resolver("POSTED", [paso(), presentada], true);
    expect(r).toMatchObject({
      fase: "CERRADO",
      origenCierre: "FUERA_DE_CONTABILIDAD_OS",
      contabilizado: true,
      cerrado: true,
      descargable: true,
    });
  });

  it("un paso no aplicable no aporta bloqueo ni declaración", () => {
    const r = resolver("DRAFT", [
      paso({ estadoCalculado: "no_aplica", estado: "REVISAR" }),
      { ...presentada, estadoCalculado: "no_aplica" },
    ]);
    expect(r).toMatchObject({ fase: "LISTO", declarado: false });
  });
});
