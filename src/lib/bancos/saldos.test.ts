import { describe, it, expect } from "vitest";
import { esSaldoDeFuenteDura, resolverSaldos, type EntradasSaldo } from "./saldos";

function entradas(over: Partial<EntradasSaldo> = {}): EntradasSaldo {
  return {
    capturadoInicial: null,
    capturadoFinal: null,
    estadoInicial: null,
    estadoFinal: null,
    ancla: null,
    netoDelMes: 0,
    ...over,
  };
}

describe("resolverSaldos — con un ancla, los demás meses salen solos", () => {
  it("lo capturado gana sobre todo lo demás", () => {
    const r = resolverSaldos(
      entradas({ capturadoInicial: 100, capturadoFinal: 250, estadoInicial: 1, estadoFinal: 2, netoDelMes: 999 })
    );
    expect(r.inicial).toMatchObject({ valor: 100, fuente: "capturado" });
    expect(r.final).toMatchObject({ valor: 250, fuente: "capturado" });
  });

  it("sin captura toma el estado de cuenta importado", () => {
    const r = resolverSaldos(entradas({ estadoInicial: 500, estadoFinal: 700 }));
    expect(r.inicial).toMatchObject({ valor: 500, fuente: "estado" });
    expect(r.final).toMatchObject({ valor: 700, fuente: "estado" });
  });

  it("arrastra el inicial desde el último saldo conocido y calcula el final", () => {
    const r = resolverSaldos(
      entradas({
        ancla: { saldo: 1000, etiqueta: "mayo 2026", netoHastaInicioDelMes: -300 },
        netoDelMes: 250.5,
      })
    );
    expect(r.inicial).toMatchObject({ valor: 700, fuente: "arrastre" });
    expect(r.inicial.etiqueta).toContain("mayo 2026");
    expect(r.final).toMatchObject({ valor: 950.5, fuente: "calculado" });
    // Un final calculado sobre un inicial arrastrado dice de dónde viene.
    expect(r.final.etiqueta).toContain("mayo 2026");
  });

  it("calcula el final cuando el inicial sí está capturado", () => {
    const r = resolverSaldos(entradas({ capturadoInicial: 1000, netoDelMes: -120.25 }));
    expect(r.final).toMatchObject({ valor: 879.75, fuente: "calculado" });
  });

  it("sin ancla en ninguna parte lo dice, en vez de inventar un cero", () => {
    const r = resolverSaldos(entradas({ netoDelMes: 5000 }));
    expect(r.inicial.valor).toBeNull();
    expect(r.inicial.fuente).toBe("sin-dato");
    expect(r.final.valor).toBeNull();
    expect(r.final.fuente).toBe("sin-dato");
  });

  it("un final capturado no contagia su firmeza al inicial arrastrado", () => {
    const r = resolverSaldos(
      entradas({ capturadoFinal: 900, ancla: { saldo: 100, etiqueta: "enero 2026", netoHastaInicioDelMes: 0 } })
    );
    expect(esSaldoDeFuenteDura(r.final.fuente)).toBe(true);
    expect(esSaldoDeFuenteDura(r.inicial.fuente)).toBe(false);
  });
});
