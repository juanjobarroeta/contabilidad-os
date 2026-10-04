import { describe, expect, it } from "vitest";
import { diagnosticarSync, esRechazoCertificado } from "./sat-salud";

const hoy = new Date("2026-10-04T12:00:00Z");
const dias = (n: number) => new Date(hoy.getTime() - n * 86_400_000);
const base = { autoSyncEnabled: true, createdAt: dias(60), lastAutoSyncAt: dias(1), rechazosCertificado: [] as Date[], ultimoFinished: dias(1) };
const ok = { estado: "ok" as const, vigencia: "2028-07-04T00:00:00.000Z", diasRestantes: 600 };

describe("diagnosticarSync", () => {
  it("sana: sin motivo", () => {
    expect(diagnosticarSync({ ...base, fiel: ok }, hoy).detenida).toBe(false);
  });

  it("e.firma vencida (BAHJ)", () => {
    const r = diagnosticarSync({ ...base, fiel: { estado: "vencida", vigencia: "2026-07-25T12:00:00.000Z", diasRestantes: -70 } }, hoy);
    expect(r).toMatchObject({ detenida: true, motivo: "fiel_vencida" });
    expect(r.detalle).toContain("25/07/2026");
  });

  it("revocada por el SAT aunque el .cer siga vigente (TEGJ): 304 sin descarga exitosa después", () => {
    const r = diagnosticarSync({ ...base, fiel: ok, rechazosCertificado: [dias(3), dias(1)], ultimoFinished: dias(10) }, hoy);
    expect(r).toMatchObject({ detenida: true, motivo: "fiel_revocada" });
    // Se repuso la e.firma: hubo descarga exitosa después del primer rechazo.
    expect(diagnosticarSync({ ...base, fiel: ok, rechazosCertificado: [dias(3)], ultimoFinished: dias(1) }, hoy).detenida).toBe(false);
  });

  it("sin sincronizar más de 7 días", () => {
    expect(diagnosticarSync({ ...base, fiel: ok, lastAutoSyncAt: dias(9) }, hoy)).toMatchObject({ detenida: true, motivo: "sin_sync" });
    expect(diagnosticarSync({ ...base, fiel: ok, lastAutoSyncAt: dias(5) }, hoy).detenida).toBe(false);
    // Empresa recién dada de alta: todavía no cuenta.
    expect(diagnosticarSync({ ...base, fiel: ok, createdAt: dias(2), lastAutoSyncAt: null }, hoy).detenida).toBe(false);
    // Sync apagado a propósito: no es un fallo.
    expect(diagnosticarSync({ ...base, fiel: ok, autoSyncEnabled: false, lastAutoSyncAt: dias(30) }, hoy).detenida).toBe(false);
  });

  it("esRechazoCertificado reconoce el texto del SAT", () => {
    expect(esRechazoCertificado("emitidos rechazado por SAT: Certificado Revocado o Caduco (código 304)")).toBe(true);
    expect(esRechazoCertificado("Error no controlado.")).toBe(false);
  });
});
