import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ find: vi.fn(), tx: vi.fn(), imss: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { employee: { findFirst: m.find }, $transaction: m.tx } }));

import { actualizarEmpleado, empleadoSchema } from "./empleados";

const empleado = { id: "e1", companyId: "c", salarioDiario: 500, salarioDiarioIntegrado: 525, fechaIngreso: new Date("2024-01-01T00:00:00Z") };

beforeEach(() => {
  vi.clearAllMocks();
  m.find.mockResolvedValue(empleado);
  m.update.mockImplementation(({ data }) => Promise.resolve({ ...empleado, ...data }));
  m.tx.mockImplementation((fn) => fn({ imssMovimiento: { create: m.imss }, employee: { update: m.update } }));
});

describe("editar empleado", () => {
  it("un aumento registra la modificación al IMSS junto con la edición", async () => {
    const r = await actualizarEmpleado("c", "e1", { salarioDiario: 600 });
    expect(r.status).toBe(200);
    expect(m.imss.mock.calls[0][0].data).toMatchObject({ tipo: "MODIFICACION_SALARIO", sbcAnterior: 525 });
    expect(m.update.mock.calls[0][0].data.salarioDiario).toBe(600);
  });
  it("el mismo salario (Decimal en la base) no genera aviso al IMSS", async () => {
    m.find.mockResolvedValueOnce({ ...empleado, salarioDiario: { toString: () => "500", valueOf: () => 500 } });
    await actualizarEmpleado("c", "e1", { salarioDiario: 500, puesto: "Enfermera" });
    expect(m.imss).not.toHaveBeenCalled();
    expect(m.update.mock.calls[0][0].data.salarioDiario).toBeUndefined();
  });
  it("skipImssMovimiento corrige sin aviso al IMSS", async () => {
    await actualizarEmpleado("c", "e1", { salarioDiario: 600, skipImssMovimiento: true });
    expect(m.imss).not.toHaveBeenCalled();
  });
  it("una CLABE inválida no deja un movimiento huérfano", async () => {
    const r = await actualizarEmpleado("c", "e1", { salarioDiario: 600, clabe: "123" });
    expect(r.status).toBe(400);
    expect(m.tx).not.toHaveBeenCalled();
  });
  it("sin campos conocidos → 400; otra empresa → 404", async () => {
    expect((await actualizarEmpleado("c", "e1", { rfc: "X" })).status).toBe(400);
    m.find.mockResolvedValueOnce(null);
    expect((await actualizarEmpleado("c", "e1", { puesto: "x" })).status).toBe(404);
  });
  it("el alta valida RFC, CURP y NSS", () => {
    const ok = { companyId: "c", nombre: "Ana", apellidoPaterno: "Ruiz", rfc: "RUAA900101AB1", curp: "RUAA900101MDFZNN09", nss: "12345678901", fechaIngreso: "2026-01-01", salarioDiario: 400 };
    expect(empleadoSchema.safeParse(ok).success).toBe(true);
    expect(empleadoSchema.safeParse({ ...ok, nss: "123" }).success).toBe(false);
  });
});
