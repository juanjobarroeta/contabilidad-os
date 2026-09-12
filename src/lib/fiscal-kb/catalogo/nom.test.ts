import { describe, expect, it } from "vitest";
import { esNomConstruccion, hostPublico, materiasDeNom, parsearFichaNom, siglasDe } from "./nom";

const FICHA_SEDE = `<p>Inicio &gt; Normalización &gt; Catálogo Mexicano de Normas &gt; NOM-001-SEDE-2012</p>
<h2>Información principal</h2><p>Clave de la Norma: NOM-001-SEDE-2012</p><p>Título de la Norma: Instalaciones Eléctricas (utilización)</p>
<p>Estado de la Norma: Vigente</p><p>Fecha de publicación en el DOF: 29/11/2012</p><p>Fecha de entrada en vigor: 29/5/2013</p>
<p>Dependencia(s): Secretaría de Energía</p><p>Comité que desarrolló la Norma: Comité Consultivo Nacional</p>
<a href="http://10.100.20.231/wp-content/uploads/sites/2/PDF_Normas_Publicas/001sede2012.pdf">PDF</a>
<a href="https://dof.gob.mx/nota_detalle.php?codigo=5280623&#038;fecha=29/11/2012">DOF</a>`;

describe("parsearFichaNom", () => {
  it("lee clave, título, estado, fechas, dependencia y el PDF en el host público", () => {
    const e = parsearFichaNom("NOM-001-SEDE-2012", FICHA_SEDE, "https://platiica.economia.gob.mx/normalizacion/nom-001-sede-2012/")!;
    expect(e.clave).toBe("NOM-001-SEDE-2012");
    expect(e.titulo).toBe("Instalaciones Eléctricas (utilización)");
    expect(e.estado).toBe("Vigente");
    expect(e.fechaDof).toBe("2012-11-29");
    expect(e.entradaEnVigor).toBe("2013-05-29");
    expect(e.dependencias).toEqual(["Secretaría de Energía"]);
    expect(e.url).toBe("https://platiica.economia.gob.mx/wp-content/uploads/sites/2/PDF_Normas_Publicas/001sede2012.pdf");
    expect(e.materias).toEqual(["construccion", "energia"]);
    expect(e.excluida).toBeNull();
  });
  it("una cancelada o sin PDF queda excluida con motivo", () => {
    const c = parsearFichaNom("NOM-003-SEDE-1999", FICHA_SEDE.replace("Vigente", "Cancelada"), "u")!;
    expect(c.excluida).toMatch(/Cancelada/);
    const s = parsearFichaNom("NOM-001-SEDE-2012", FICHA_SEDE.replace(/<a href="[^"]*PDF_Normas[^"]*">PDF<\/a>/, ""), "u")!;
    expect(s.url).toBeNull();
    expect(s.excluida).toMatch(/Sin PDF/);
  });
  it("una NMX o un post sin clave NOM no entra", () => {
    expect(parsearFichaNom("NMX-J-027-ANCE-1999", "<p>Clave de la Norma: NMX-J-027-ANCE-1999</p>", "u")).toBeNull();
  });
});

describe("materias y filtro de construcción", () => {
  it("las siglas dicen la dependencia", () => {
    expect(siglasDe("NOM-031-STPS-2011")).toBe("STPS");
    expect(siglasDe("NOM-001-CONAGUA-2011")).toBe("CONAGUA");
    expect(siglasDe("NOM-008-ENER-2001")).toBe("ENER");
    expect(siglasDe("basura")).toBeNull();
  });
  it("construcción: SEDE/ENER/CONAGUA/SEDATU siempre; STPS y las demás por título", () => {
    expect(esNomConstruccion("NOM-001-SEDE-2012", "Instalaciones Eléctricas (utilización)")).toBe(true);
    expect(esNomConstruccion("NOM-031-STPS-2011", "Construcción-Condiciones de seguridad y salud en el trabajo")).toBe(true);
    expect(esNomConstruccion("NOM-035-STPS-2018", "Factores de riesgo psicosocial en el trabajo")).toBe(false);
    expect(esNomConstruccion("NOM-051-SCFI/SSA1-2010", "Etiquetado de alimentos")).toBe(false);
    expect(materiasDeNom("NOM-035-STPS-2018", "Factores de riesgo psicosocial")).toEqual(["laboral", "construccion"]);
  });
  it("reescribe la IP interna al host público", () => {
    expect(hostPublico("http://10.100.20.231/normalizacion/x/")).toBe("https://platiica.economia.gob.mx/normalizacion/x/");
  });
});
