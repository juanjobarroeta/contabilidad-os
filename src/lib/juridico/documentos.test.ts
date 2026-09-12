import { describe, expect, it } from "vitest";
import { bloqueDocumentosParaPrompt, buscarEnDocumento, compactarSecciones, ejecutarHerramientaDocumento, indexarDocumento, leerDocumento, limpiarTexto, type DocumentoCargado } from "./documentos";

const CONTRATO = `CONTRATO DE PRESTACIÓN DE SERVICIOS que celebran por una parte ACME, S.A. DE C.V. (el «Cliente») y por la otra Juan Pérez (el «Prestador»).

DECLARACIONES

I. Declara el Cliente que es una sociedad mercantil constituida conforme a las leyes mexicanas.
II. Declara el Prestador que cuenta con la capacidad técnica para prestar los servicios.

CLÁUSULAS

PRIMERA.- OBJETO. El Prestador se obliga a desarrollar el software descrito en el Anexo A.

SEGUNDA.- CONTRAPRESTACIÓN. El Cliente pagará $100,000.00 M.N. más IVA en dos exhibiciones.

TERCERA.- PENA CONVENCIONAL. Por cada día de retraso el Prestador pagará el 1% del monto total, sin exceder del 20%.

CUARTA.- JURISDICCIÓN. Las partes se someten a los tribunales de la Ciudad de México, renunciando a cualquier otro fuero.

TRANSITORIOS

ÚNICO. El presente contrato entra en vigor el día de su firma.`;

function doc(texto: string): DocumentoCargado {
  const t = limpiarTexto(texto);
  return { id: "d1", nombre: "contrato.pdf", paginas: 3, caracteres: t.length, texto: t, secciones: indexarDocumento(t) };
}

describe("indexarDocumento", () => {
  it("detecta el proemio, los apartados en mayúsculas y las cláusulas por ordinal", () => {
    const s = indexarDocumento(limpiarTexto(CONTRATO));
    const titulos = s.map((x) => x.titulo);
    // El proemio (mixto y largo) no es encabezado: queda como sección «Inicio».
    expect(titulos[0]).toMatch(/^Inicio/);
    expect(s[0].desde).toBe(0);
    expect(titulos).toContain("DECLARACIONES");
    expect(titulos).toContain("CLÁUSULAS");
    expect(titulos.some((t) => t.startsWith("PRIMERA.- OBJETO"))).toBe(true);
    expect(titulos.some((t) => t.startsWith("CUARTA.- JURISDICCIÓN"))).toBe(true);
    expect(titulos).toContain("TRANSITORIOS");
    // Offsets contiguos y numerados desde 1.
    for (let i = 0; i < s.length; i++) {
      expect(s[i].n).toBe(i + 1);
      if (i > 0) expect(s[i].desde).toBe(s[i - 1].hasta);
    }
    expect(s[s.length - 1].hasta).toBe(limpiarTexto(CONTRATO).length);
  });
  it("un texto sin encabezados es una sola sección", () => {
    expect(indexarDocumento("hola que tal, esto es un párrafo sin más.")).toEqual([{ n: 1, titulo: "Documento completo", desde: 0, hasta: 41 }]);
  });
  it("una ley de cientos de artículos se compacta a ≤ 300 secciones contiguas; un contrato no se toca", () => {
    const ley = Array.from({ length: 900 }, (_, i) => `Artículo ${i + 1}. Texto del artículo ${i + 1} con su contenido normativo suficiente para contar.`).join("\n\n");
    const s = indexarDocumento(ley);
    // 900 artículos de ~90 chars → secciones contiguas de hasta 6 000 chars.
    expect(s.length).toBeLessThanOrEqual(300);
    expect(s.length).toBeGreaterThanOrEqual(10);
    for (const x of s) expect(x.hasta - x.desde).toBeLessThanOrEqual(6_000);
    expect(s[0].desde).toBe(0);
    expect(s[s.length - 1].hasta).toBe(ley.length);
    for (let i = 1; i < s.length; i++) expect(s[i].desde).toBe(s[i - 1].hasta);
    expect(s[0].titulo).toMatch(/^Artículo 1\. … Artículo \d+/);
    const contrato = indexarDocumento(limpiarTexto(CONTRATO));
    expect(compactarSecciones(contrato)).toEqual(contrato);
  });
  it("las líneas de declaraciones numeradas con romanos también cuentan", () => {
    const s = indexarDocumento(limpiarTexto(CONTRATO));
    expect(s.some((x) => x.titulo.startsWith("I. Declara el Cliente"))).toBe(true);
  });
});

describe("leerDocumento", () => {
  const d = doc(CONTRATO);
  it("sin argumentos: el índice; con sección: su texto", () => {
    const idx = leerDocumento(d, {}) as { secciones: { n: number; titulo: string }[] };
    expect(idx.secciones.length).toBe(d.secciones.length);
    const pena = d.secciones.find((s) => s.titulo.startsWith("TERCERA"))!;
    const r = leerDocumento(d, { seccion: pena.n }) as { texto: string; titulo: string };
    expect(r.texto).toMatch(/1% del monto total/);
    expect(r.titulo).toMatch(/PENA CONVENCIONAL/);
  });
  it("una sección inexistente y un rango se manejan", () => {
    expect((leerDocumento(d, { seccion: 99 }) as { error: string }).error).toMatch(/No hay sección 99/);
    const r = leerDocumento(d, { desde: 0, hasta: 20 }) as { texto: string };
    expect(r.texto).toBe(d.texto.slice(0, 20));
  });
});

describe("buscarEnDocumento", () => {
  const d = doc(CONTRATO);
  it("encuentra el pasaje por términos sin acentos y lo ubica en su sección", () => {
    const r = buscarEnDocumento(d, "penalizacion por retraso");
    expect(r.resultados[0].fragmento).toMatch(/retraso/);
    expect(r.resultados[0].titulo).toMatch(/PENA CONVENCIONAL/);
  });
  it("jurisdicción y fuero", () => {
    const r = buscarEnDocumento(d, "¿a qué tribunales se someten?");
    expect(r.resultados[0].titulo).toMatch(/JURISDICCI/);
  });
  it("sin coincidencias devuelve vacío, no error", () => {
    expect(buscarEnDocumento(d, "criptomonedas").resultados).toEqual([]);
  });
});

describe("ejecutarHerramientaDocumento y prompt", () => {
  const d = doc(CONTRATO);
  it("con un solo documento no hace falta el id; con varios, sí", () => {
    const uno = JSON.parse(ejecutarHerramientaDocumento("buscar_en_documento", { consulta: "contraprestación" }, [d])) as { resultados: unknown[] };
    expect(uno.resultados.length).toBeGreaterThan(0);
    const varios = JSON.parse(ejecutarHerramientaDocumento("leer_documento", {}, [d, { ...d, id: "d2" }])) as { error: string };
    expect(varios.error).toMatch(/documento_id/);
  });
  it("el bloque del prompt trae el índice y, si cabe, el texto completo", () => {
    const b = bloqueDocumentosParaPrompt([d]);
    expect(b).toMatch(/documento_id «d1»/);
    expect(b).toMatch(/PRIMERA\.- OBJETO/);
    expect(b).toMatch(/Texto completo de «contrato.pdf»/);
    const grande = { ...d, caracteres: 500_000 };
    expect(bloqueDocumentosParaPrompt([grande])).not.toMatch(/Texto completo/);
  });
});
