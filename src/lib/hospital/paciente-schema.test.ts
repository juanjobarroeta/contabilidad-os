import { describe, expect, it } from "vitest";
import { digitoVerificadorCurp } from "./curp";
import { fechaNacimientoDe, resolverIdentidadCurp } from "./paciente-schema";
import { partesLocales } from "./tz";

// Mujer nacida el 14-mar-1992 en Puebla (persona ficticia, dígito real).
const BASE = "OERF920314MPLRZR0";
const CURP = BASE + digitoVerificadorCurp(BASE);

describe("fechaNacimientoDe", () => {
  it("una fecha a secas es el día local (mediodía), un ISO con hora es el instante", () => {
    const d = fechaNacimientoDe("1992-03-14")!;
    expect(partesLocales(d)).toMatchObject({ y: 1992, m: 3, d: 14, h: 12 });
    expect(fechaNacimientoDe("1992-03-14T18:30:00.000Z")!.toISOString()).toBe("1992-03-14T18:30:00.000Z");
    expect(fechaNacimientoDe(null)).toBeNull();
    expect(fechaNacimientoDe("no es fecha")).toBeNull();
  });
});

describe("resolverIdentidadCurp", () => {
  it("con CURP válida llena fecha, sexo y entidad y la marca validada", () => {
    const r = resolverIdentidadCurp({ curp: ` ${CURP.toLowerCase()} `, exigirCurp: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.curp).toBe(CURP);
    expect(r.datos.curpValidada).toBe(true);
    expect(r.datos.sexo).toBe("FEMENINO");
    expect(r.datos.entidadNacimiento).toBe("Puebla");
    expect(partesLocales(r.datos.fechaNacimiento!)).toMatchObject({ y: 1992, m: 3, d: 14 });
    expect(r.datos.sinCurp).toBe(false);
  });

  it("rechaza CURP inválida con el motivo en español", () => {
    const r = resolverIdentidadCurp({ curp: BASE + "9", exigirCurp: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/dígito verificador/);
  });

  it("la ficha no puede contradecir la CURP", () => {
    const fecha = resolverIdentidadCurp({ curp: CURP, fechaNacimiento: fechaNacimientoDe("1992-03-15"), exigirCurp: true });
    expect(fecha.ok).toBe(false);
    if (!fecha.ok) expect(fecha.error).toMatch(/fecha de nacimiento \(1992-03-15\) no coincide .*1992-03-14/);
    const sexo = resolverIdentidadCurp({ curp: CURP, sexo: "MASCULINO", exigirCurp: true });
    expect(sexo.ok).toBe(false);
    if (!sexo.ok) expect(sexo.error).toMatch(/sexo/);
    // Coincidente y con OTRO (la CURP sólo distingue H/M): pasa.
    expect(resolverIdentidadCurp({ curp: CURP, sexo: "FEMENINO", fechaNacimiento: fechaNacimientoDe("1992-03-14"), exigirCurp: true }).ok).toBe(true);
    expect(resolverIdentidadCurp({ curp: CURP, sexo: "OTRO", exigirCurp: true }).ok).toBe(true);
  });

  it("sin CURP exige motivo; con motivo la admite y limpia la CURP", () => {
    const sinMotivo = resolverIdentidadCurp({ sinCurp: true, exigirCurp: true });
    expect(sinMotivo.ok).toBe(false);
    if (!sinMotivo.ok) expect(sinMotivo.error).toMatch(/motivo/);
    const r = resolverIdentidadCurp({ curp: CURP, sinCurp: true, sinCurpMotivo: " Extranjera sin CURP ", exigirCurp: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.datos).toMatchObject({ curp: null, curpValidada: false, sinCurp: true, sinCurpMotivo: "Extranjera sin CURP" });
  });

  it("CURP vacía: 400 al crear, tolerada en ediciones que no tocan la identidad", () => {
    const crear = resolverIdentidadCurp({ curp: "", exigirCurp: true });
    expect(crear.ok).toBe(false);
    if (!crear.ok) expect(crear.error).toMatch(/obligatoria/);
    const editar = resolverIdentidadCurp({ curp: null, sexo: "OTRO", exigirCurp: false });
    expect(editar.ok).toBe(true);
    if (editar.ok) expect(editar.datos).toMatchObject({ curp: null, curpValidada: false, sexo: "OTRO" });
  });
});
