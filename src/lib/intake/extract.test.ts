import { describe, expect, it } from "vitest";
import { LULL_MS, MAX_WINDOW_MS, parseExtractionOutput, partitionWhatsappBatches, type WaRow } from "./extract";

const T0 = new Date("2026-08-19T12:00:00Z").getTime();

function row(id: string, phone: string, minAgo: number): WaRow {
  return {
    id,
    phone,
    receivedAt: new Date(T0 - minAgo * 60_000),
    body: `msg ${id}`,
    profileName: null,
  };
}

describe("partitionWhatsappBatches", () => {
  const now = new Date(T0);

  it("una conversación con pausa ≥30 min está lista", () => {
    const batches = partitionWhatsappBatches([row("a", "+521", 45), row("b", "+521", 35)], now);
    expect(batches).toHaveLength(1);
    expect(batches[0].rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("una conversación activa (último mensaje reciente) espera", () => {
    const batches = partitionWhatsappBatches([row("a", "+521", 45), row("b", "+521", 5)], now);
    expect(batches).toHaveLength(0);
  });

  it("el tope de 6 h fuerza la extracción aunque sigan escribiendo", () => {
    const viejaMin = MAX_WINDOW_MS / 60_000 + 1;
    const batches = partitionWhatsappBatches([row("a", "+521", viejaMin), row("b", "+521", 2)], now);
    expect(batches).toHaveLength(1);
  });

  it("agrupa por contacto y ordena por fecha", () => {
    const batches = partitionWhatsappBatches(
      [row("b", "+521", 35), row("x", "+522", 40), row("a", "+521", 50)],
      now
    );
    expect(batches).toHaveLength(2);
    const c1 = batches.find((b) => b.phone === "+521")!;
    expect(c1.rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("frontera exacta del lull cuenta como lista", () => {
    const batches = partitionWhatsappBatches([row("a", "+521", LULL_MS / 60_000)], now);
    expect(batches).toHaveLength(1);
  });
});

describe("parseExtractionOutput", () => {
  const ask = {
    title: "Descarga masiva de CFDIs por rango de fechas",
    body: "El cliente necesita bajar todos los CFDIs de un periodo en una sola acción.",
    quote: "tengo que bajarlos uno por uno",
    quote_ts_sec: 842,
    product: "contabilidados",
    kind: "feature",
    confidence: 0.85,
  };

  it("parsea JSON limpio", () => {
    const out = parseExtractionOutput(JSON.stringify({ asks: [ask], notes: "resto" }));
    expect(out.asks).toHaveLength(1);
    expect(out.asks[0].kind).toBe("FEATURE");
    expect(out.asks[0].product).toBe("contabilidados");
    expect(out.notes).toBe("resto");
  });

  it("tolera fences y prosa alrededor", () => {
    const text = "Claro, aquí está:\n```json\n" + JSON.stringify({ asks: [ask], notes: "" }) + "\n```\nSaludos";
    expect(parseExtractionOutput(text).asks).toHaveLength(1);
  });

  it("aplica el piso de confianza 0.5 en código, no solo en el prompt", () => {
    const out = parseExtractionOutput(JSON.stringify({ asks: [{ ...ask, confidence: 0.4 }], notes: "" }));
    expect(out.asks).toHaveLength(0);
  });

  it("descarta kind=noise y malformados", () => {
    const out = parseExtractionOutput(
      JSON.stringify({ asks: [{ ...ask, kind: "noise" }, { title: "", body: "x", kind: "bug", confidence: 1 }], notes: "" })
    );
    expect(out.asks).toHaveLength(0);
  });

  it("producto desconocido se vuelve null (el hint decide después)", () => {
    const out = parseExtractionOutput(JSON.stringify({ asks: [{ ...ask, product: "inventado" }], notes: "" }));
    expect(out.asks[0].product).toBeNull();
  });

  it("devuelve vacío ante basura", () => {
    expect(parseExtractionOutput("no hay json aquí").asks).toHaveLength(0);
    expect(parseExtractionOutput("{rotísimo").asks).toHaveLength(0);
  });
});
