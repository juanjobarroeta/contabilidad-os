import { describe, it, expect, beforeEach } from "vitest";
import {
  aplicarParejas,
  contraparteComun,
  cuentaAuxiliar,
  emparejarAuxiliares,
  esNombreDeRelleno,
} from "./auxiliar-contraparte";
import { COE_CODES } from "./catalog";

// Base mínima en memoria: sólo lo que toca este módulo.
type Cta = { id: string; companyId: string; cuentaSAT: string; subcuenta: string | null; nombre: string; isActive: boolean; codAgrup: string | null; customerId: string | null };
type Cli = { id: string; companyId: string; razonSocial: string; rfc: string };

let cuentas: Cta[] = [];
let clientes: Cli[] = [];

const cta = (id: string, nombre: string, codAgrup: string = COE_CODES.PROVEEDORES, customerId: string | null = null): Cta => ({
  id, companyId: "c1", cuentaSAT: "2110", subcuenta: `2110-${id}-000`, nombre, isActive: true, codAgrup, customerId,
});
const cli = (id: string, razonSocial: string): Cli => ({ id, companyId: "c1", razonSocial, rfc: `RFC${id}` });

const coincide = (f: Record<string, unknown>, w: Record<string, unknown>): boolean =>
  Object.entries(w).every(([k, v]) => (v === null ? f[k] == null : f[k] === v));

const db = {
  chartAccount: {
    findMany: async ({ where }: never) => cuentas.filter((c) => coincide(c as never, where)),
    findFirst: async ({ where }: never) => cuentas.find((c) => coincide(c as never, where)) ?? null,
    updateMany: async ({ where, data }: never) => {
      let count = 0;
      for (const c of cuentas) {
        if (coincide(c as never, where)) { Object.assign(c, data); count++; }
      }
      return { count };
    },
  },
  customer: { findMany: async ({ where }: never) => clientes.filter((c) => coincide(c as never, where)) },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

beforeEach(() => { cuentas = []; clientes = []; });

describe("esNombreDeRelleno()", () => {
  it("reconoce lo que un catálogo pone de relleno", () => {
    // Vistos en producción, en REYES HUERTA y BARTIZ.
    for (const n of ["SALDO INICIAL", "PROVEEDOR #", "Clientes", "VARIOS", "Por identificar"]) {
      expect(esNombreDeRelleno(n), n).toBe(true);
    }
  });

  it("no confunde una contraparte con relleno", () => {
    for (const n of ["TELEFONOS DE MEXICO", "CFE SUMINISTRADOR DE SERVICIOS BASICOS"]) {
      expect(esNombreDeRelleno(n), n).toBe(false);
    }
  });
});

describe("emparejarAuxiliares()", () => {
  it("empareja por nombre idéntico y lo marca EXACTA", async () => {
    cuentas = [cta("002", "TELEFONOS DE MEXICO")];
    clientes = [cli("t", "Teléfonos de México, S.A. de C.V.")];
    const r = await emparejarAuxiliares(db, "c1", COE_CODES.PROVEEDORES);
    expect(r.pares).toHaveLength(1);
    expect(r.pares[0].confianza).toBe("EXACTA");
    expect(r.pares[0].customerId).toBe("t");
    expect(r.pares[0].codigo).toBe("2110-002-000");
  });

  it("el catálogo trunca, y eso es PARECIDA — no exacta", async () => {
    // Visto en TMA: «GRUPO LA ESPERANZA DE SAN RAFAEL DE ARRI».
    cuentas = [cta("006", "GRUPO LA ESPERANZA DE SAN RAFAEL DE ARRI")];
    clientes = [cli("g", "GRUPO LA ESPERANZA DE SAN RAFAEL DE ARRIBA SA DE CV")];
    const r = await emparejarAuxiliares(db, "c1", COE_CODES.PROVEEDORES);
    expect(r.pares[0]?.confianza).toBe("PARECIDA");
  });

  it("si el nombre empata con DOS contrapartes no propone ninguna", async () => {
    cuentas = [cta("010", "CONSTRUCTORA BARTIZ")];
    clientes = [cli("a", "CONSTRUCTORA BARTIZ VERT SA DE CV"), cli("b", "CONSTRUCTORA BARTIZ NORTE SA DE CV")];
    const r = await emparejarAuxiliares(db, "c1", COE_CODES.PROVEEDORES);
    expect(r.pares).toHaveLength(0);
    expect(r.sinPareja[0].motivo).toBe("varias_candidatas");
  });

  it("si DOS auxiliares apuntan a la misma contraparte, ninguno se sostiene", async () => {
    cuentas = [cta("011", "SUPERAVIT COMERCIALIZADORA"), cta("012", "SUPERAVIT COMERCIALIZADORA")];
    clientes = [cli("s", "SUPERAVIT COMERCIALIZADORA INDUSTRIAL")];
    const r = await emparejarAuxiliares(db, "c1", COE_CODES.PROVEEDORES);
    expect(r.pares).toHaveLength(0);
    expect(r.sinPareja).toHaveLength(2);
  });

  it("el relleno no empareja aunque se parezca a algo", async () => {
    cuentas = [cta("001", "SALDO INICIAL")];
    clientes = [cli("x", "SALDO INICIAL SA DE CV")];
    const r = await emparejarAuxiliares(db, "c1", COE_CODES.PROVEEDORES);
    expect(r.pares).toHaveLength(0);
  });

  it("no vuelve a proponer lo ya ligado", async () => {
    cuentas = [cta("002", "TELEFONOS DE MEXICO", COE_CODES.PROVEEDORES, "t")];
    clientes = [cli("t", "TELEFONOS DE MEXICO")];
    const r = await emparejarAuxiliares(db, "c1", COE_CODES.PROVEEDORES);
    expect(r.yaLigados).toBe(1);
    expect(r.pares).toHaveLength(0);
  });

  it("un código FIJO no se empareja por contraparte", async () => {
    // 401.01 es una decisión de persona, no un padrón.
    cuentas = [cta("x", "VENTAS AL 16%", COE_CODES.VENTAS_GENERAL)];
    clientes = [cli("v", "VENTAS AL 16%")];
    const r = await emparejarAuxiliares(db, "c1", COE_CODES.VENTAS_GENERAL);
    expect(r.pares).toHaveLength(0);
  });

  it("un catálogo FUNCIONAL no empareja nada, y eso es correcto", async () => {
    // MARGOM: «CXP PLANTA VEHICULOS» no es una contraparte del padrón.
    cuentas = [cta("a", "CXP PLANTA VEHICULOS"), cta("b", "CXP FINANCIERA VEHICULOS")];
    clientes = [cli("p", "NISSAN MEXICANA SA DE CV"), cli("q", "NR FINANCE MEXICO SA DE CV")];
    const r = await emparejarAuxiliares(db, "c1", COE_CODES.PROVEEDORES);
    expect(r.pares).toHaveLength(0);
    expect(r.sinPareja).toHaveLength(2);
  });
});

describe("aplicarParejas()", () => {
  it("por default escribe SÓLO las exactas", async () => {
    cuentas = [cta("002", "TELEFONOS DE MEXICO"), cta("006", "GRUPO LA ESPERANZA DE SAN RAFAEL DE ARRI")];
    clientes = [cli("t", "TELEFONOS DE MEXICO"), cli("g", "GRUPO LA ESPERANZA DE SAN RAFAEL DE ARRIBA SA DE CV")];
    const r = await emparejarAuxiliares(db, "c1", COE_CODES.PROVEEDORES);
    expect(await aplicarParejas(db, "c1", r.pares)).toBe(1);
    expect(cuentas.find((c) => c.id === "002")!.customerId).toBe("t");
    expect(cuentas.find((c) => c.id === "006")!.customerId).toBeNull();
  });

  it("con soloExactas:false escribe lo confirmado por una persona", async () => {
    cuentas = [cta("006", "GRUPO LA ESPERANZA DE SAN RAFAEL DE ARRI")];
    clientes = [cli("g", "GRUPO LA ESPERANZA DE SAN RAFAEL DE ARRIBA SA DE CV")];
    const r = await emparejarAuxiliares(db, "c1", COE_CODES.PROVEEDORES);
    expect(await aplicarParejas(db, "c1", r.pares, { soloExactas: false })).toBe(1);
  });

  it("nunca pisa un enlace que ya existe", async () => {
    cuentas = [cta("002", "TELEFONOS DE MEXICO", COE_CODES.PROVEEDORES, "otro-cliente")];
    clientes = [cli("t", "TELEFONOS DE MEXICO")];
    const r = { pares: [{ chartAccountId: "002", codigo: "2110-002-000", nombreCuenta: "TELEFONOS DE MEXICO", customerId: "t", customerNombre: "TELEFONOS DE MEXICO", customerRfc: "RFCt", confianza: "EXACTA" as const }] };
    expect(await aplicarParejas(db, "c1", r.pares)).toBe(0);
    expect(cuentas[0].customerId).toBe("otro-cliente");
  });

  it("la MISMA contraparte puede quedar en varios auxiliares de códigos distintos", async () => {
    // BAOBAB: SUPERAVIT COMERCIALIZADORA es proveedor, acreedor y deudor a la
    // vez. Con el enlace en Customer sólo cabía uno y los otros dos se perdían
    // en silencio — por esto la columna se movió a la cuenta.
    cuentas = [
      cta("018", "SUPERAVIT COMERCIALIZADORA", COE_CODES.PROVEEDORES),
      cta("007", "SUPERAVIT COMERCIALIZADORA", COE_CODES.ACREEDORES_DIVERSOS),
    ];
    clientes = [cli("s", "SUPERAVIT COMERCIALIZADORA")];

    const prov = await emparejarAuxiliares(db, "c1", COE_CODES.PROVEEDORES);
    expect(await aplicarParejas(db, "c1", prov.pares)).toBe(1);
    const acre = await emparejarAuxiliares(db, "c1", COE_CODES.ACREEDORES_DIVERSOS);
    expect(await aplicarParejas(db, "c1", acre.pares)).toBe(1);

    expect(cuentas.find((c) => c.id === "018")!.customerId).toBe("s");
    expect(cuentas.find((c) => c.id === "007")!.customerId).toBe("s");
  });
});

describe("cuentaAuxiliar() — la resolución del posteo", () => {
  const idx = new Map([
    ["201.01|cli-telmex", "cta-2110-002"],
    ["205.02|cli-superavit", "cta-2120-007"],
    ["201.01|cli-superavit", "cta-2110-018"],
  ]);

  it("devuelve el auxiliar de esa contraparte para ESE código", () => {
    expect(cuentaAuxiliar(idx, "201.01", "cli-telmex")).toBe("cta-2110-002");
  });

  it("la misma contraparte resuelve distinto según el código", () => {
    // SUPERAVIT es proveedor Y acreedor: cada papel, su auxiliar.
    expect(cuentaAuxiliar(idx, "201.01", "cli-superavit")).toBe("cta-2110-018");
    expect(cuentaAuxiliar(idx, "205.02", "cli-superavit")).toBe("cta-2120-007");
  });

  it("sin enlace devuelve null, que es «cae a la cuenta base»", () => {
    expect(cuentaAuxiliar(idx, "201.01", "cli-sin-ligar")).toBeNull();
    expect(cuentaAuxiliar(idx, "105.01", "cli-telmex")).toBeNull();
  });

  it("sin contraparte no hay nada que resolver", () => {
    expect(cuentaAuxiliar(idx, "201.01", null)).toBeNull();
    expect(cuentaAuxiliar(idx, "201.01", undefined)).toBeNull();
  });
});

describe("contraparteComun() — un pago que cubre varias facturas", () => {
  const porInvoice = new Map<string, string | null>([
    ["f1", "cli-a"],
    ["f2", "cli-a"],
    ["f3", "cli-b"],
    ["f4", null],
  ]);

  it("varias facturas del MISMO cliente resuelven a ese cliente", () => {
    expect(contraparteComun(porInvoice, ["f1", "f2"])).toBe("cli-a");
  });

  it("facturas de clientes DISTINTOS no resuelven: el pago va a la base", () => {
    // El motor abona en UN renglón; no existe un auxiliar que sea el correcto
    // para los dos. Caer a la cuenta base es lo honesto.
    expect(contraparteComun(porInvoice, ["f1", "f3"])).toBeNull();
  });

  it("una factura sin contraparte no arrastra a las demás", () => {
    expect(contraparteComun(porInvoice, ["f1", "f4"])).toBeNull();
    expect(contraparteComun(porInvoice, ["f4"])).toBeNull();
  });

  it("un pago sin facturas conciliadas no resuelve", () => {
    expect(contraparteComun(porInvoice, [])).toBeNull();
  });

  it("el match 1:1 es el caso común y resuelve", () => {
    expect(contraparteComun(porInvoice, ["f1"])).toBe("cli-a");
  });
});
