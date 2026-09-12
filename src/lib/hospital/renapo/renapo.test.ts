import { describe, expect, it, vi } from "vitest";
import { errorNubarium, normalizarNubarium, proveedorNubarium, NUBARIUM_URL_OBTENER, NUBARIUM_URL_VALIDAR } from "./nubarium";
import { estadoProveedor, obtenerProveedor, type FetchLike } from "./proveedor";
import { RenapoError, ESTATUS_CURP, esEstatusActivo, fechaDdMmYyyyAIso, isoAFechaDdMmYyyy } from "./tipos";
import { errorTlaloc, normalizarTlaloc, proveedorTlaloc, TLALOC_URL } from "./tlaloc";

const TLALOC_OK = {
  nacionalidad: "MEX",
  docProbatorio: 1,
  statusCurp: "AN",
  nombres: "CONCEPCION",
  parametro: "SABC560626MDFLRN01",
  primerApellido: "SALGADO",
  segundoApellido: "BRISEÑO",
  curp: "SABC560626MDFLRN01",
  fechaNacimiento: "26/06/1956",
  sexo: "MUJER",
  datosDocProbatorio: { anioReg: "1956", claveEntidadRegistro: "09", claveMunicipioRegistro: "015", numActa: "00123", tomo: "2", libro: "1", foja: "44" },
  claveEntidad: "DF",
  entidad: "CIUDAD DE MEXICO",
};

const NUBARIUM_OK = {
  estatus: "OK",
  codigoValidacion: "9f1c2a",
  curp: "SABC560626MDFLRN01",
  nombre: "CONCEPCION",
  apellidoPaterno: "SALGADO",
  apellidoMaterno: "BRISEÑO",
  sexo: "MUJER",
  fechaNacimiento: "26/06/1956",
  paisNacimiento: "MÉXICO",
  estadoNacimiento: "CIUDAD DE MÉXICO",
  docProbatorio: 1,
  datosDocProbatorio: { anioReg: "1956", numActa: "00123" },
  estatusCurp: "AN",
  codigoMensaje: "0",
};

/** fetch de mentira: devuelve lo programado y guarda la última llamada. */
function fetchFalso(status: number, body: unknown, headers: Record<string, string> = {}) {
  const llamadas: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn: FetchLike = async (url, init) => {
    llamadas.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  };
  return { fn, llamadas };
}

describe("vocabulario RENAPO", () => {
  it("estatus activos y bajas, fechas dd/mm/yyyy ↔ ISO", () => {
    expect(esEstatusActivo("AN")).toBe(true);
    expect(esEstatusActivo("rcn")).toBe(true);
    expect(esEstatusActivo("BD")).toBe(false);
    expect(esEstatusActivo("BSU")).toBe(false);
    expect(esEstatusActivo(null)).toBe(false);
    expect(Object.keys(ESTATUS_CURP)).toEqual(["AN", "AH", "RCC", "RCN", "BD", "BSU", "BAP", "BDM", "BDP", "BJD"]);
    expect(fechaDdMmYyyyAIso("26/06/1956")).toBe("1956-06-26");
    expect(fechaDdMmYyyyAIso("1956-06-26")).toBe("1956-06-26");
    expect(fechaDdMmYyyyAIso("31/02/1956")).toBeNull();
    expect(fechaDdMmYyyyAIso("")).toBeNull();
    expect(isoAFechaDdMmYyyy("1956-06-26")).toBe("26/06/1956");
  });
});

describe("Tláloc", () => {
  it("normaliza la respuesta al vocabulario de RENAPO", () => {
    const r = normalizarTlaloc(TLALOC_OK, "req-1", new Date("2026-09-05T12:00:00Z"));
    expect(r).toMatchObject({
      curp: "SABC560626MDFLRN01",
      nombres: "CONCEPCION",
      primerApellido: "SALGADO",
      segundoApellido: "BRISEÑO",
      sexo: "M",
      fechaNacimiento: "1956-06-26",
      entidadClave: "DF",
      entidadNombre: "CIUDAD DE MEXICO",
      nacionalidad: "MEX",
      estatusCurp: "AN",
      activa: true,
      docProbatorio: "1",
      docProbatorioDescripcion: "Acta de nacimiento",
      proveedor: "tlaloc",
      referencia: "req-1",
      consultadoEn: "2026-09-05T12:00:00.000Z",
    });
    expect(r.datosDocProbatorio).toMatchObject({ numActa: "00123" });
    // Baja: activa=false y sin segundo apellido.
    expect(normalizarTlaloc({ ...TLALOC_OK, statusCurp: "BD", segundoApellido: "" })).toMatchObject({ activa: false, estatusCurp: "BD", segundoApellido: null });
  });

  it("mapea los códigos HTTP a errores del dominio", () => {
    expect(errorTlaloc(404, { error: "not_found", message: "CURP no encontrada" }).codigo).toBe("NOT_FOUND");
    expect(errorTlaloc(400, { error: "bad_request", message: "curp inválida" })).toMatchObject({ codigo: "INVALID_FORMAT", message: expect.stringMatching(/curp inválida/) });
    expect(errorTlaloc(422, { error: "unprocessable", message: "multiple matches" }).codigo).toBe("MULTIPLE_MATCHES");
    expect(errorTlaloc(422, { error: "unprocessable", message: "date_of_birth inválida" }).codigo).toBe("INVALID_FORMAT");
    expect(errorTlaloc(401, {}).codigo).toBe("PROVIDER_AUTH");
    expect(errorTlaloc(429, {}).codigo).toBe("RATE_LIMITED");
    expect(errorTlaloc(500, { error: "renapo_down" }).codigo).toBe("UPSTREAM_UNAVAILABLE");
    expect(errorTlaloc(503, null).codigo).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("consulta por CURP con Bearer y por datos con los parámetros de la API", async () => {
    const ok = fetchFalso(200, TLALOC_OK, { "x-request-id": "abc" });
    const p = proveedorTlaloc("clave-secreta", { fetchImpl: ok.fn });
    const r = await p.consultarPorCurp(" sabc560626mdflrn01 ");
    expect(r.curp).toBe("SABC560626MDFLRN01");
    expect(r.referencia).toBe("abc");
    expect(ok.llamadas[0].url).toBe(`${TLALOC_URL}?curp=SABC560626MDFLRN01`);
    expect((ok.llamadas[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer clave-secreta");

    const lista = fetchFalso(200, [TLALOC_OK, { ...TLALOC_OK, curp: "SABC560626MDFLRN12", statusCurp: "AH" }]);
    const p2 = proveedorTlaloc("k", { fetchImpl: lista.fn });
    const rs = await p2.buscarPorDatos({ nombres: "Concepción", primerApellido: "Salgado", segundoApellido: "Briseño", fechaNacimiento: "1956-06-26", sexo: "M", entidadClave: "DF" });
    expect(rs).toHaveLength(2);
    const url = new URL(lista.llamadas[0].url);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      names: "Concepción",
      first_last_name: "Salgado",
      second_last_name: "Briseño",
      date_of_birth: "1956-06-26",
      gender: "M",
      state_of_birth: "DF",
    });
  });

  it("404 → NOT_FOUND, 503 → UPSTREAM_UNAVAILABLE, red caída → UPSTREAM_UNAVAILABLE, timeout → UPSTREAM_UNAVAILABLE", async () => {
    await expect(proveedorTlaloc("k", { fetchImpl: fetchFalso(404, { error: "not_found" }).fn }).consultarPorCurp("SABC560626MDFLRN01")).rejects.toMatchObject({ codigo: "NOT_FOUND" });
    await expect(proveedorTlaloc("k", { fetchImpl: fetchFalso(503, { error: "down" }).fn }).consultarPorCurp("SABC560626MDFLRN01")).rejects.toMatchObject({ codigo: "UPSTREAM_UNAVAILABLE", status: 503 });
    const caida: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(proveedorTlaloc("k", { fetchImpl: caida }).consultarPorCurp("SABC560626MDFLRN01")).rejects.toBeInstanceOf(RenapoError);
    const lenta: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    await expect(proveedorTlaloc("k", { fetchImpl: lenta, timeoutMs: 20 }).consultarPorCurp("SABC560626MDFLRN01")).rejects.toMatchObject({ codigo: "UPSTREAM_UNAVAILABLE", message: expect.stringMatching(/no respondió/) });
  });
});

describe("Nubarium", () => {
  it("normaliza la respuesta (estado de nacimiento por nombre → clave RENAPO)", () => {
    const r = normalizarNubarium(NUBARIUM_OK, new Date("2026-09-05T12:00:00Z"));
    expect(r).toMatchObject({
      curp: "SABC560626MDFLRN01",
      nombres: "CONCEPCION",
      primerApellido: "SALGADO",
      segundoApellido: "BRISEÑO",
      sexo: "M",
      fechaNacimiento: "1956-06-26",
      entidadClave: "DF",
      entidadNombre: "CIUDAD DE MÉXICO",
      nacionalidad: "MEX",
      estatusCurp: "AN",
      activa: true,
      docProbatorio: "1",
      proveedor: "nubarium",
      referencia: "9f1c2a",
    });
  });

  it("el límite agotado y los mensajes de error se vuelven códigos del dominio", () => {
    expect(errorNubarium(200, { codigoMensaje: "-1", estatus: "ERROR" }).codigo).toBe("RATE_LIMITED");
    expect(errorNubarium(200, { estatus: "ERROR", codigoMensaje: "1", mensaje: "CURP no encontrada en RENAPO" }).codigo).toBe("NOT_FOUND");
    expect(errorNubarium(200, { estatus: "ERROR", mensaje: "Formato de CURP inválido" }).codigo).toBe("INVALID_FORMAT");
    expect(errorNubarium(401, {}).codigo).toBe("PROVIDER_AUTH");
    expect(errorNubarium(429, {}).codigo).toBe("RATE_LIMITED");
    expect(errorNubarium(502, {}).codigo).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("valida por CURP y busca por datos con Basic Auth y fecha dd/mm/yyyy", async () => {
    const ok = fetchFalso(200, NUBARIUM_OK);
    const p = proveedorNubarium("usuario", "secreto", { fetchImpl: ok.fn });
    const r = await p.consultarPorCurp("sabc560626mdflrn01");
    expect(r.curp).toBe("SABC560626MDFLRN01");
    expect(ok.llamadas[0].url).toBe(NUBARIUM_URL_VALIDAR);
    expect(ok.llamadas[0].init?.method).toBe("POST");
    expect((ok.llamadas[0].init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("usuario:secreto").toString("base64")}`);
    expect(JSON.parse(String(ok.llamadas[0].init?.body))).toEqual({ curp: "SABC560626MDFLRN01" });

    const rs = await p.buscarPorDatos({ nombres: "Concepción", primerApellido: "Salgado", segundoApellido: null, fechaNacimiento: "1956-06-26", sexo: "M", entidadClave: "DF" });
    expect(rs).toHaveLength(1);
    expect(ok.llamadas[1].url).toBe(NUBARIUM_URL_OBTENER);
    expect(JSON.parse(String(ok.llamadas[1].init?.body))).toEqual({ nombre: "Concepción", primerApellido: "Salgado", segundoApellido: "", fechaNacimiento: "26/06/1956", entidad: "DF", sexo: "M" });

    const limite = fetchFalso(200, { codigoMensaje: "-1", estatus: "ERROR" });
    await expect(proveedorNubarium("u", "p", { fetchImpl: limite.fn }).consultarPorCurp("SABC560626MDFLRN01")).rejects.toMatchObject({ codigo: "RATE_LIMITED" });
  });
});

describe("obtenerProveedor (variables de entorno)", () => {
  it("sin RENAPO_PROVEEDOR o sin credenciales no hay proveedor, con motivo legible", () => {
    expect(obtenerProveedor({})).toBeNull();
    expect(estadoProveedor({})).toMatchObject({ proveedor: null, configurado: false, motivo: expect.stringMatching(/RENAPO_PROVEEDOR/) });
    expect(estadoProveedor({ RENAPO_PROVEEDOR: "tlaloc" })).toMatchObject({ proveedor: "tlaloc", configurado: false, motivo: expect.stringMatching(/TLALOC_API_KEY/) });
    expect(estadoProveedor({ RENAPO_PROVEEDOR: "nubarium", NUBARIUM_USUARIO: "u" })).toMatchObject({ proveedor: "nubarium", configurado: false });
    expect(estadoProveedor({ RENAPO_PROVEEDOR: "otro" })).toMatchObject({ proveedor: null, configurado: false, motivo: expect.stringMatching(/desconocido/) });
  });

  it("con credenciales devuelve el proveedor pedido", () => {
    const fetchImpl = vi.fn() as unknown as FetchLike;
    expect(obtenerProveedor({ RENAPO_PROVEEDOR: "tlaloc", TLALOC_API_KEY: "k" }, fetchImpl)?.nombre).toBe("tlaloc");
    expect(obtenerProveedor({ RENAPO_PROVEEDOR: "Nubarium", NUBARIUM_USUARIO: "u", NUBARIUM_PASSWORD: "p" }, fetchImpl)?.nombre).toBe("nubarium");
  });
});

describe("Tláloc: búsqueda de quien sólo tiene un apellido", () => {
  // Tláloc exige `second_last_name`. Omitirlo contesta 422 «Provide either
  // 'curp' or all of…», que el mapeo de errores traduce a «formato inválido»:
  // el usuario veía un error de captura y en realidad nunca se buscó.
  // Verificado contra la API: con X la consulta entra.
  function capturarParams(segundoApellido: string | null) {
    let visto: URL | null = null;
    const fetchImpl = (async (url: string) => {
      visto = new URL(url);
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const prov = proveedorTlaloc("k", { fetchImpl });
    return prov
      .buscarPorDatos({
        nombres: "JUAN",
        primerApellido: "PEREZ",
        segundoApellido,
        fechaNacimiento: "1990-05-05",
        sexo: "H",
        entidadClave: "DF",
      })
      .then(() => visto!.searchParams);
  }

  it("manda X cuando no hay segundo apellido", async () => {
    expect((await capturarParams(null)).get("second_last_name")).toBe("X");
  });

  it("trata una cadena vacía como ausencia, no la manda vacía", async () => {
    expect((await capturarParams("   ")).get("second_last_name")).toBe("X");
  });

  it("manda el apellido cuando sí lo hay", async () => {
    expect((await capturarParams("LOPEZ")).get("second_last_name")).toBe("LOPEZ");
  });

  it("siempre manda los seis parámetros que Tláloc exige", async () => {
    const p = await capturarParams(null);
    for (const k of ["names", "first_last_name", "second_last_name", "date_of_birth", "gender", "state_of_birth"]) {
      expect(p.get(k), k).toBeTruthy();
    }
  });
});
