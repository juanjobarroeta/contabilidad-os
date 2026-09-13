import * as Sentry from "@sentry/node";
import { afterAll, describe, expect, it } from "vitest";
import { observabilityEnabled, reportError } from "./observability";

// Simula lo que pasa en Next: OTRA copia del módulo (instrumentation.ts)
// inicializó Sentry; esta copia nunca corrió initObservability().
const enviados: unknown[] = [];

describe("reportError con el cliente inicializado desde otro chunk", () => {
  afterAll(async () => {
    await Sentry.getClient()?.close(100);
  });

  it("antes de init no reporta ni truena", () => {
    expect(observabilityEnabled()).toBe(false);
    expect(() => reportError(new Error("nadie escucha"))).not.toThrow();
    expect(enviados).toHaveLength(0);
  });

  it("con cliente global captura la excepción con sus tags aunque `initialized` local sea false", async () => {
    Sentry.init({
      dsn: "https://publico@o0.ingest.sentry.io/1",
      transport: () => ({
        send: async (envelope: unknown) => {
          enviados.push(envelope);
          return {};
        },
        flush: async () => true,
      }),
    });
    expect(observabilityEnabled()).toBe(true);
    reportError(new Error("turno muerto"), { ruta: "juridico/chat", conversacionId: "c1" });
    await Sentry.flush(1000);
    expect(enviados).toHaveLength(1);
    const texto = JSON.stringify(enviados[0]);
    expect(texto).toContain("turno muerto");
    expect(texto).toContain('"ruta":"juridico/chat"');
  });
});
