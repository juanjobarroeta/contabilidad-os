import { describe, expect, it } from "vitest";
import { askKeyboard, parseCallback, parseEditMarker, renderAskCard, type AskConRelaciones } from "./telegram";

function fakeAsk(overrides: Partial<AskConRelaciones> = {}): AskConRelaciones {
  return {
    id: "ck123",
    rawIntakeId: null,
    transcriptId: null,
    contactId: null,
    product: "automotriz",
    kind: "FEATURE",
    title: "Exportar órdenes de servicio a Excel",
    body: "El cliente necesita sacar las órdenes a Excel para su contador.",
    quote: "necesito sacarlo a Excel para el contador",
    quoteTsSec: 762,
    confidence: 0.72,
    dedupeOfId: null,
    status: "PENDING",
    reviewedAt: null,
    notifiedAt: null,
    telegramMessageId: null,
    githubIssueUrl: null,
    githubNodeId: null,
    createdAt: new Date("2026-08-14T18:00:00Z"),
    contact: null,
    transcript: null,
    dedupeOf: null,
    ...overrides,
  } as AskConRelaciones;
}

describe("parseCallback", () => {
  it("parsea ask:<id>:<action>", () => {
    expect(parseCallback("ask:ck123:approve")).toEqual({ askId: "ck123", action: "approve" });
    expect(parseCallback("ask:ck123:discard")?.action).toBe("discard");
  });

  it("rechaza acciones desconocidas y basura", () => {
    expect(parseCallback("ask:ck123:delete")).toBeNull();
    expect(parseCallback("otra:cosa")).toBeNull();
    expect(parseCallback(null)).toBeNull();
    expect(parseCallback("ask:id con espacios:approve")).toBeNull();
  });
});

describe("parseEditMarker", () => {
  it("encuentra el marcador #ask:<id>", () => {
    expect(parseEditMarker("✏️ Responde a ESTE mensaje con el nuevo título. #ask:ck123")).toBe("ck123");
  });
  it("sin marcador devuelve null", () => {
    expect(parseEditMarker("hola")).toBeNull();
    expect(parseEditMarker(undefined)).toBeNull();
  });
});

describe("renderAskCard", () => {
  it("incluye producto, kind, confianza, título y cita", () => {
    const card = renderAskCard(fakeAsk());
    expect(card).toContain("AutomotrizPro");
    expect(card).toContain("feature");
    expect(card).toContain("conf 0.72");
    expect(card).toContain("Exportar órdenes de servicio a Excel");
    expect(card).toContain("necesito sacarlo a Excel");
  });

  it("marca el posible duplicado", () => {
    const card = renderAskCard(
      fakeAsk({ dedupeOfId: "x", dedupeOf: fakeAsk({ id: "x", title: "Export a Excel de órdenes" }) })
    );
    expect(card).toContain("Posible duplicado");
  });
});

describe("askKeyboard", () => {
  it("sin duplicado: Crear / Editar / Descartar", () => {
    const kb = askKeyboard(fakeAsk());
    const textos = kb.inline_keyboard[0].map((b) => b.text);
    expect(textos).toEqual(["✅ Crear", "✏️ Editar", "❌ Descartar"]);
  });

  it("con duplicado agrega Merge y el callback_data es parseable", () => {
    const kb = askKeyboard(fakeAsk({ dedupeOfId: "x" }));
    const merge = kb.inline_keyboard[0].find((b) => b.text.includes("Merge"))!;
    expect(parseCallback(merge.callback_data)).toEqual({ askId: "ck123", action: "merge" });
  });
});
