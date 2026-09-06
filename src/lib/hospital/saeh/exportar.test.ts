import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENCABEZADO_SAEH,
  TOTAL_VARIABLES,
  VARIABLES_SAEH,
  bytesArchivoSaeh,
  camposDeLinea,
  camposDeRegistro,
  desempaquetarProcedimientos,
  empaquetarProcedimientos,
  formatearFolioSaeh,
  lineaDeCampos,
  nombreArchivoSaeh,
  parsearArchivoSaeh,
  registroDeCampos,
  siguienteConsecutivoSaeh,
  textoArchivoSaeh,
} from "./exportar";
import { fechaSaeh, normalizarCedula, normalizarDescripcion, normalizarNombre, pesoSaeh, quitarAcentos, tiempoQuirofanoValido } from "./texto";

const MUESTRA = path.join(__dirname, "__fixtures__", "EGR-DFSSA-2605.txt");
const bytesMuestra = () => fs.readFileSync(MUESTRA);

describe("archivo de intercambio SAEH (GIIS-B002-05-09)", () => {
  it("el encabezado es el del archivo muestra de la DGIS, erratas incluidas", () => {
    const lineas = bytesMuestra().toString("latin1").split("\n");
    expect(VARIABLES_SAEH).toHaveLength(TOTAL_VARIABLES);
    expect(ENCABEZADO_SAEH).toBe(lineas[0]);
    // Las dos anomalías del archivo oficial: causaExterna rotulada PRIMERAPELLIDO y PROCEDIMIESTOS.
    expect(VARIABLES_SAEH[52]).toBe("PRIMERAPELLIDO");
    expect(VARIABLES_SAEH[53]).toBe("CODIGOCIECAUSAEXTERNA");
    expect(VARIABLES_SAEH[56]).toBe("PROCEDIMIESTOS");
  });

  it("parsea la muestra: 4 registros de 82 campos con compuestas desempaquetadas", () => {
    const { registros, lineas } = parsearArchivoSaeh(bytesMuestra());
    expect(lineas).toHaveLength(5);
    expect(registros).toHaveLength(4);
    const r = registros[0];
    expect(r.clues).toBe("DFSMP016844");
    expect(r.folio).toBe("20260590");
    expect(r.peso).toBe(75.255);
    expect(r.claveServicioAdicional).toEqual(["603", "606"]);
    expect(r.comorbilidades).toHaveLength(6);
    expect(r.comorbilidades[1]).toEqual({ descripcion: "SUPERVISION DE EMBARAZO", codigo: "Z350" });
    expect(r.procedimientos).toHaveLength(8);
    expect(r.procedimientos[5]).toEqual({ descripcion: "PARTO MULTIPLE POR CESAREA", codigo: "741X", tipoAnestesia: 1, quirofano: 1, tiempoQuirofano: "01:30", cedula: "27091026Ñ03" });
    expect(r.productos).toHaveLength(6);
    expect(r.productos[0]).toEqual({ condicionNacimiento: 2, condicionNacidoVivo: 1, folioCertificado: "026234790", apgar5: 8, reanimacion: 2, alojamientoConjunto: 1, lactanciaExclusiva: 1 });
    expect(r.primerApellidoResponsable).toBe("CÖSS");
    // Registro sin comorbilidades ni productos: campos vacíos («||»).
    expect(registros[3].curpPaciente).toBe("XXXX999999XXXXXX99");
    expect(registros[3].fechaNacimiento).toBe("09/09/9999");
    expect(registros[3].sexoCURP).toBe(0);
    expect(registros[3].productos).toEqual([]);
    expect(registros[3].tipoServicioIngreso).toBe(2);
    expect(registros[3].claveServicioIngreso).toBe("-1");
    expect(registros[3].claveServicioAdicional).toEqual([]);
  });

  it("ida y vuelta byte a byte: parsear la muestra y volverla a serializar da el mismo archivo", () => {
    const original = bytesMuestra();
    const { registros, lineas } = parsearArchivoSaeh(original);
    // Nivel campos: cada renglón se rearma idéntico.
    for (const l of lineas) expect(lineaDeCampos(camposDeLinea(l))).toBe(l);
    // Nivel registro tipado: números, fechas y compuestas conservan su forma.
    for (const [i, r] of registros.entries()) expect(lineaDeCampos(camposDeRegistro(r))).toBe(lineas[i + 1]);
    // Nivel archivo: mismos bytes Latin-1 (Ñ = 0xD1, Ö = 0xD6), LF y sin salto final.
    const regenerado = bytesArchivoSaeh(registros);
    expect(regenerado.equals(original)).toBe(true);
    expect(original.includes(Buffer.from([0xd1]))).toBe(true);
    expect(original.includes(Buffer.from([0x0d]))).toBe(false);
    expect(textoArchivoSaeh(registros).endsWith("\n")).toBe(false);
  });

  it("registroDeCampos ↔ camposDeRegistro conservan los 82 campos", () => {
    const campos = camposDeLinea(bytesMuestra().toString("latin1").split("\n")[2]);
    expect(campos).toHaveLength(TOTAL_VARIABLES);
    expect(camposDeRegistro(registroDeCampos(campos))).toEqual(campos);
  });

  it("empaqueta procedimientos con «#» y «&» dejando vacíos tiempo y cédula fuera de quirófano", () => {
    const lista = [
      { descripcion: "COLONOSCOPIA", codigo: "4523", tipoAnestesia: 4, quirofano: 2, tiempoQuirofano: "", cedula: "" },
      { descripcion: "APENDICECTOMIA LAPAROSCOPICA", codigo: "4701", tipoAnestesia: 1, quirofano: 1, tiempoQuirofano: "01:15", cedula: "5583201" },
    ];
    const texto = empaquetarProcedimientos(lista);
    expect(texto).toBe("1#COLONOSCOPIA#4523#4#2##&2#APENDICECTOMIA LAPAROSCOPICA#4701#1#1#01:15#5583201");
    expect(desempaquetarProcedimientos(texto)).toEqual(lista);
  });

  it("nombra el archivo EGR-{EE}{III}-{AA}{MM}.TXT", () => {
    expect(nombreArchivoSaeh("PLSMP000014", "SMP", 2026, 9)).toBe("EGR-PLSMP-2609.TXT");
    expect(nombreArchivoSaeh("DFSSA004072", null, 2026, 5)).toBe("EGR-DFSSA-2605.TXT");
    expect(nombreArchivoSaeh(null, null, 2026, 12)).toBe("EGR-XXSMP-2612.TXT");
  });

  it("folio SAEH: AAMM + consecutivo de 4 dígitos, único por mes", () => {
    expect(formatearFolioSaeh(2026, 9, 1)).toBe("26090001");
    expect(siguienteConsecutivoSaeh([], 2026, 9)).toBe(1);
    expect(siguienteConsecutivoSaeh(["26090001", "26090007", "26080099", null], 2026, 9)).toBe(8);
  });
});

describe("texto y formatos de la GIIS", () => {
  it("quita acentos conservando la Ñ y, en nombres, la diéresis", () => {
    expect(quitarAcentos("Peña Ríos Güemes")).toBe("Peña Rios Guemes");
    expect(quitarAcentos("Peña Ríos Güemes", true)).toBe("Peña Rios Güemes");
    expect(normalizarNombre("  ma. del  rocío   de la torre-ñúñez ")).toBe("MA. DEL ROCIO DE LA TORRE-ÑUÑEZ");
    expect(normalizarNombre("Cöss")).toBe("CÖSS");
    expect(normalizarNombre("O'Connor & Hijos (2)")).toBe("O'CONNOR HIJOS");
    expect(normalizarNombre("Ruiz--López")).toBe("RUIZ-LOPEZ");
  });

  it("descripciones: sólo 0-9 A-Z Ñ, inician con letra, máximo 250", () => {
    expect(normalizarDescripcion("Colecistectomía, laparoscópica (electiva).")).toBe("COLECISTECTOMIA LAPAROSCOPICA ELECTIVA");
    expect(normalizarDescripcion("2 fracturas de tibia")).toBe("FRACTURAS DE TIBIA");
    expect(normalizarDescripcion("x".repeat(300))).toHaveLength(250);
    expect(normalizarDescripcion(null)).toBe("");
  });

  it("cédula: mayúsculas, sin signos, ceros a la izquierda hasta 6", () => {
    expect(normalizarCedula(" 12345 ")).toBe("012345");
    expect(normalizarCedula("55-83-201")).toBe("5583201");
    expect(normalizarCedula("2610ñ28")).toBe("2610Ñ28");
    expect(normalizarCedula(null)).toBe("");
  });

  it("fechas dd/mm/aaaa en hora local y peso ###.###", () => {
    // 2026-09-01 02:00 UTC es todavía 31 de agosto en la Ciudad de México.
    expect(fechaSaeh(new Date("2026-09-01T02:00:00Z"))).toBe("31/08/2026");
    expect(fechaSaeh(new Date("2026-09-04T20:45:00Z"))).toBe("04/09/2026");
    expect(pesoSaeh(75.255)).toBe("75.255");
    expect(pesoSaeh(80)).toBe("80.000");
    expect(pesoSaeh(999)).toBe("999");
    expect(pesoSaeh(null)).toBe("");
  });

  it("tiempo de quirófano HH:MM entre 00:01 y 48:00 o 99:99", () => {
    expect(tiempoQuirofanoValido("00:01")).toBe(true);
    expect(tiempoQuirofanoValido("48:00")).toBe(true);
    expect(tiempoQuirofanoValido("99:99")).toBe(true);
    expect(tiempoQuirofanoValido("00:00")).toBe(false);
    expect(tiempoQuirofanoValido("48:01")).toBe(false);
    expect(tiempoQuirofanoValido("1:30")).toBe(false);
    expect(tiempoQuirofanoValido("01:60")).toBe(false);
  });
});
