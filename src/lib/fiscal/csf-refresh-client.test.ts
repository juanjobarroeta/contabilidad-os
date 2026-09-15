import { afterEach, describe, expect, it, vi } from "vitest";
import {
  interpretCsfRefreshResponse,
  refreshCompanyFromCsf,
} from "./csf-refresh-client";

describe("CSF refresh client contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the server success message", () => {
    expect(interpretCsfRefreshResponse(
      { ok: true, status: 200 },
      { message: "2 regímenes actualizados" },
    )).toEqual({ kind: "SUCCESS", message: "2 regímenes actualizados" });
  });

  it("exposes a safe, de-duplicated primary choice", () => {
    expect(interpretCsfRefreshResponse(
      { ok: false, status: 422 },
      {
        code: "PRIMARY_REQUIRED",
        error: "Elige el régimen principal",
        regimenes: [
          { codigo: "605", nombre: "Sueldos", desde: "01/01/2024" },
          { codigo: "605", nombre: "Duplicado", desde: "" },
          { codigo: "612", nombre: "Actividad empresarial", desde: "" },
          { codigo: "no", nombre: "Inválido" },
        ],
      },
    )).toEqual({
      kind: "PRIMARY_REQUIRED",
      message: "Elige el régimen principal",
      regimenes: [
        { codigo: "605", nombre: "Sueldos", desde: "01/01/2024" },
        { codigo: "612", nombre: "Actividad empresarial", desde: "" },
      ],
    });
  });

  it("fails closed when a primary-required response has no usable choices", () => {
    expect(interpretCsfRefreshResponse(
      { ok: false, status: 422 },
      { code: "PRIMARY_REQUIRED", error: "Sin opciones", regimenes: [] },
    )).toEqual({ kind: "ERROR", code: "PRIMARY_REQUIRED", message: "Sin opciones" });
  });

  it("keeps stable error codes for ordinary failures", () => {
    expect(interpretCsfRefreshResponse(
      { ok: false, status: 422 },
      { code: "UNKNOWN_REGIME", error: "Régimen desconocido" },
    )).toEqual({ kind: "ERROR", code: "UNKNOWN_REGIME", message: "Régimen desconocido" });
  });

  it("sends the accountant's explicit primary on retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ message: "Actualizada" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await refreshCompanyFromCsf({
      companyId: "company-1",
      csfBase64: "pdf-base64",
      regimenFiscalPrincipal: "612",
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/obligaciones/csf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyId: "company-1",
        csfBase64: "pdf-base64",
        regimenFiscalPrincipal: "612",
      }),
    });
  });
});
