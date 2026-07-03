import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock del cliente prisma ANTES de importar el SUT (named export `prisma`).
const createMock = vi.fn();
vi.mock("./prisma", () => ({
  prisma: {
    auditLog: {
      get create() {
        return createMock;
      },
    },
  },
}));

import { registrarBitacora, ipDeRequest } from "./audit";

function flush() {
  // Deja correr las microtareas del .catch interno del fire-and-forget.
  return new Promise((r) => setTimeout(r, 0));
}

describe("registrarBitacora (fire-and-forget, nunca lanza)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    createMock.mockReset();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("no lanza ni genera unhandled rejection cuando prisma.create rechaza", async () => {
    createMock.mockRejectedValueOnce(new Error("db caída"));

    expect(() =>
      registrarBitacora({ companyId: "c1", accion: "factura.timbrar" })
    ).not.toThrow();

    await flush();
    // El error se registró en consola con el prefijo [bitacora].
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[bitacora]"),
      expect.any(Error)
    );
  });

  it("no lanza si prisma.create truena SÍNCRONAMENTE", async () => {
    createMock.mockImplementationOnce(() => {
      throw new Error("fallo síncrono");
    });

    expect(() =>
      registrarBitacora({ companyId: "c1", accion: "nomina.timbrar" })
    ).not.toThrow();

    await flush();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("inserta la fila con los campos normalizados", async () => {
    createMock.mockResolvedValueOnce({ id: "a1" });

    registrarBitacora({
      companyId: "c1",
      userId: "u1",
      actorEmail: "ana@ejemplo.mx",
      accion: "factura.cancelar",
      entidad: "Invoice",
      entidadId: "inv1",
      detalle: { uuid: "ABC", motivo: "02" },
      ip: "1.2.3.4",
    });

    await flush();
    expect(createMock).toHaveBeenCalledWith({
      data: {
        companyId: "c1",
        userId: "u1",
        actorEmail: "ana@ejemplo.mx",
        accion: "factura.cancelar",
        entidad: "Invoice",
        entidadId: "inv1",
        detalle: { uuid: "ABC", motivo: "02" },
        ip: "1.2.3.4",
      },
    });
  });

  it("toma la IP de x-forwarded-for cuando se pasa el Request", async () => {
    createMock.mockResolvedValueOnce({ id: "a2" });
    const req = new Request("http://localhost/api", {
      headers: { "x-forwarded-for": "10.0.0.9, 172.16.0.1" },
    });

    registrarBitacora({ companyId: "c1", accion: "miembros.agregar", req });

    await flush();
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ip: "10.0.0.9" }) })
    );
  });
});

describe("ipDeRequest", () => {
  it("devuelve el primer salto de x-forwarded-for", () => {
    const req = new Request("http://localhost", {
      headers: { "x-forwarded-for": " 8.8.8.8 , 1.1.1.1" },
    });
    expect(ipDeRequest(req)).toBe("8.8.8.8");
  });

  it("devuelve null sin encabezado, sin Request o con encabezado vacío", () => {
    expect(ipDeRequest(new Request("http://localhost"))).toBeNull();
    expect(ipDeRequest(null)).toBeNull();
    expect(ipDeRequest(undefined)).toBeNull();
  });
});
