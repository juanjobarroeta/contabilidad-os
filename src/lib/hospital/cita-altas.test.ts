import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./folio", () => ({ siguienteFolio: vi.fn(async () => "EXP-2026-0007") }));

import { resolverAltasCita } from "./cita-altas";

const estado = {
  pacientes: [] as Array<Record<string, unknown>>,
  medicos: [] as Array<Record<string, unknown>>,
  creados: [] as Array<{ modelo: string; data: Record<string, unknown> }>,
};

const tx = {
  hospPaciente: {
    findMany: vi.fn(async () => estado.pacientes),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { estado.creados.push({ modelo: "paciente", data }); return { id: "pNuevo" }; }),
  },
  hospMedico: {
    findMany: vi.fn(async () => estado.medicos),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { estado.creados.push({ modelo: "medico", data }); return { id: `m${estado.creados.length}` }; }),
  },
} as never;

const HOY = new Date("2026-10-10T12:00:00Z");

beforeEach(() => {
  estado.pacientes = [];
  estado.medicos = [];
  estado.creados = [];
});

describe("resolverAltasCita", () => {
  it("da de alta al paciente con nombre partido, fecha de nacimiento y expediente", async () => {
    const r = await resolverAltasCita(tx, "c1", { pacienteNuevo: { nombre: "Henry Noel Cruz Matías", fechaNacimiento: "2006-03-23" } }, HOY);
    expect(r).toMatchObject({ error: null, pacienteId: "pNuevo" });
    expect(estado.creados[0]).toMatchObject({
      modelo: "paciente",
      data: { companyId: "c1", nombre: "Henry Noel", apellidoPaterno: "Cruz", apellidoMaterno: "Matías", expedienteNumero: "EXP-2026-0007" },
    });
    expect((estado.creados[0].data.fechaNacimiento as Date).getFullYear()).toBe(2006);
  });

  it("liga al paciente que ya existe con el mismo nombre y fecha en vez de duplicarlo", async () => {
    estado.pacientes = [{ id: "p9", nombre: "HENRY NOEL", apellidoPaterno: "Cruz", apellidoMaterno: "Matias" }];
    const r = await resolverAltasCita(tx, "c1", { pacienteNuevo: { nombre: "Henry Noel Cruz Matías", fechaNacimiento: "2006-03-23" } }, HOY);
    expect(r).toMatchObject({ error: null, pacienteId: "p9" });
    expect(estado.creados).toHaveLength(0);
  });

  it("rechaza un paciente sin apellido o con fecha futura", async () => {
    expect((await resolverAltasCita(tx, "c1", { pacienteNuevo: { nombre: "Henry", fechaNacimiento: "2006-03-23" } }, HOY)).error).toMatch(/apellido/);
    expect((await resolverAltasCita(tx, "c1", { pacienteNuevo: { nombre: "Henry Cruz", fechaNacimiento: "2030-01-01" } }, HOY)).error).toMatch(/nacimiento/);
  });

  it("médico y anestesiólogo nuevos quedan por credencializar; el anestesiólogo con su especialidad", async () => {
    const r = await resolverAltasCita(tx, "c1", { medicoNuevo: { nombre: "Dr. Gibran Melchor" }, anestesiologoNuevo: { nombre: "Dra. Ana Ruiz" } }, HOY);
    expect(r.error).toBeNull();
    expect(estado.creados.map((c) => [c.data.nombre, c.data.especialidad, c.data.porCredencializar])).toEqual([
      ["Dr. Gibran Melchor", null, true],
      ["Dra. Ana Ruiz", "Anestesiología", true],
    ]);
  });

  it("liga al médico activo con el mismo nombre (sin acentos ni mayúsculas)", async () => {
    estado.medicos = [{ id: "m7", nombre: "DR. GIBRÁN MELCHOR" }];
    const r = await resolverAltasCita(tx, "c1", { medicoNuevo: { nombre: "Dr. Gibran Melchor" } }, HOY);
    expect(r).toMatchObject({ error: null, medicoId: "m7" });
    expect(estado.creados).toHaveLength(0);
  });

  it("con id no da de alta nada", async () => {
    const r = await resolverAltasCita(tx, "c1", { pacienteId: "p1", pacienteNuevo: { nombre: "X Y", fechaNacimiento: "2000-01-01" }, medicoId: "m1", medicoNuevo: { nombre: "Dr X" } }, HOY);
    expect(r).toMatchObject({ error: null, altas: [] });
  });
});
