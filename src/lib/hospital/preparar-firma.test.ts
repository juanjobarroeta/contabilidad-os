import { describe, expect, it, vi } from "vitest";
import { TIPOS_FIRMA_CLINICA, prepararFirmaDocumento } from "./admision";
import { TIPOS_CON_PLANTILLA } from "./plantillas-legales";

const base = {
  id: "d1", companyId: "c1", pacienteId: "p1", episodioId: null, tipo: "CONSENTIMIENTO_ANESTESIA", nombre: "Consentimiento de anestesia", estado: "PENDIENTE",
  contenido: { procedimiento: "Reducción", riesgos: "Hipotensión", beneficios: "Sin dolor", alternativas: "Bloqueo regional", tipoAnestesia: "Mixta" },
  _count: { firmas: 0 },
};

function db(doc: Record<string, unknown> | null) {
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...doc, ...data, firmas: [], archivo: null }));
  return {
    update,
    cliente: {
      hospDocumento: { findUnique: vi.fn(async () => doc), update },
      hospPaciente: { findUnique: vi.fn(async () => ({ id: "p1", companyId: "c1", pagador: null, nombre: "Henry Noel", apellidoPaterno: "Cruz", apellidoMaterno: "Matías", curp: null, rfc: null, domicilio: null, expedienteNumero: "EXP-1", fechaNacimiento: null, telefono: null, email: null })) },
      hospEpisodio: { findUnique: vi.fn(async () => null) },
      hospConfig: { findUnique: vi.fn(async () => null) },
      company: { findUnique: vi.fn(async () => ({ razonSocial: "Haltus", nombreComercial: null, rfc: null })) },
    } as never,
  };
}

describe("prepararFirmaDocumento", () => {
  it("todo tipo de firma clínica tiene texto legal", () => {
    for (const t of TIPOS_FIRMA_CLINICA) expect(TIPOS_CON_PLANTILLA as readonly string[]).toContain(t);
  });

  it("congela el texto con el contenido y fija los firmantes", async () => {
    const { cliente, update } = db(base);
    const r = await prepararFirmaDocumento(cliente, { documentoId: "d1", ahora: new Date("2026-08-03T07:45:00Z") });
    const data = update.mock.calls[0][0].data as Record<string, unknown>;
    expect(String(data.textoFirmado)).toContain("Tipo de anestesia o sedación: Mixta");
    expect(String(data.textoFirmado)).toContain("Henry Noel Cruz Matías");
    expect(data.hashContenido).toMatch(/^[0-9a-f]{64}$/);
    expect(data.firmasRequeridas).toEqual(["PACIENTE|REPRESENTANTE", "TESTIGO1", "TESTIGO2", "MEDICO"]);
    expect(r.documento.tieneTexto).toBe(true);
  });

  it("rechaza contenido incompleto, documentos firmados, con firmas o de otro tipo", async () => {
    await expect(prepararFirmaDocumento(db({ ...base, contenido: { procedimiento: "x" } }).cliente, { documentoId: "d1" })).rejects.toThrow(/le falta/);
    await expect(prepararFirmaDocumento(db({ ...base, estado: "FIRMADO" }).cliente, { documentoId: "d1" })).rejects.toThrow(/ya está firmado/);
    await expect(prepararFirmaDocumento(db({ ...base, _count: { firmas: 1 } }).cliente, { documentoId: "d1" })).rejects.toThrow(/ya tiene firmas/);
    await expect(prepararFirmaDocumento(db({ ...base, tipo: "RECETA" }).cliente, { documentoId: "d1" })).rejects.toThrow(/no se firma en pantalla/);
    await expect(prepararFirmaDocumento(db(null).cliente, { documentoId: "d1" })).rejects.toThrow(/no encontrado/);
  });
});
