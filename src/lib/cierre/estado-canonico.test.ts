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

function resolver(estadoContable: EstadoContableCierre | null, pasos: PasoParaEstadoCierre[]) {
  return resolverEstadoCierre({ estadoContable, pasos });
}

const presentada = paso({
  clave: "declaracion",
  titulo: "Declaración",
  senales: [{ clave: "fx:declaracion-periodo", estado: "ok", resumen: "Presentada" }],
});

describe("resolverEstadoCierre", () => {
  it("avanza LISTO → POSTEADO → CERRADO desde una sola fuente", () => {
    expect(resolver("DRAFT", [paso()])).toMatchObject({
      fase: "LISTO",
      listo: true,
      posteado: false,
      cerrado: false,
      descargable: false,
      puedePostear: true,
    });
    expect(resolver("POSTED", [paso()])).toMatchObject({
      fase: "POSTEADO",
      posteado: true,
      cerrado: false,
      descargable: true,
    });
    expect(resolver("POSTED", [paso(), presentada])).toMatchObject({
      fase: "CERRADO",
      declarado: true,
      posteado: true,
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
      posteado: false,
      cerrado: false,
      descargable: false,
      puedePostear: false,
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
    expect(r).toMatchObject({ fase: "POSTEADO", listo: true, descargable: true });
    expect(r.bloqueos).toEqual([]);
  });

  it("un paso no aplicable no aporta bloqueo ni declaración", () => {
    const r = resolver("DRAFT", [
      paso({ estadoCalculado: "no_aplica", estado: "REVISAR" }),
      { ...presentada, estadoCalculado: "no_aplica" },
    ]);
    expect(r).toMatchObject({ fase: "LISTO", declarado: false });
  });
});
