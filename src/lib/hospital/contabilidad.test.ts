import { describe, it, expect } from "vitest";
import { CODIGO_AGRUPADOR_OFICIAL } from "../contabilidad/codigo-agrupador";
import {
  CLAVES_MOTOR,
  CUENTAS_HOSPITAL,
  MAPA_DEFAULT,
  claveDeCargo,
  codigoMotorDe,
  definicionCatalogo,
  leerConfigCuentas,
  localizarCuenta,
  mapaCuentas,
  resolverCuenta,
} from "./contabilidad";
import { DbFalsa, comoDb } from "./__fixtures__/db-falsa";

describe("mapa de claves del motor", () => {
  it("cada default es un código agrupador oficial del SAT", () => {
    for (const clave of CLAVES_MOTOR) {
      expect(CODIGO_AGRUPADOR_OFICIAL[MAPA_DEFAULT[clave].cuentaSAT], clave).toBeDefined();
    }
  });

  it("las cuentas extra del hospital llevan el nombre oficial", () => {
    for (const c of CUENTAS_HOSPITAL) {
      expect(c.nombre).toBe(CODIGO_AGRUPADOR_OFICIAL[c.subcuenta ?? c.cuentaSAT]);
    }
  });

  // El mapa pedía elegir UNA de las once cuentas bancarias del catálogo para
  // una clave que ningún asiento usa: el efectivo entra a CAJA, la tarjeta a
  // FONDOS_EN_TRANSITO, y el depósito lo concilia el hub contra el estado de
  // cuenta. Preguntarlo era pedirle al contador que inventara una respuesta.
  it("BANCOS no es una clave: el módulo no postea contra la cuenta de bancos", () => {
    expect((CLAVES_MOTOR as readonly string[]).includes("BANCOS")).toBe(false);
  });

  it("los honorarios son pasivo, no ingreso", () => {
    expect(MAPA_DEFAULT.HONORARIOS_POR_CUENTA_DE_TERCEROS.tipo).toBe("PASIVO");
    expect(MAPA_DEFAULT.HONORARIOS_POR_CUENTA_DE_TERCEROS.cuentaSAT).toBe("205.06");
    expect(MAPA_DEFAULT.INGRESO_FARMACIA_0.cuentaSAT).toBe("401.04");
  });
});

describe("claveDeCargo()", () => {
  it("categoría → clave", () => {
    expect(claveDeCargo({ categoria: "HABITACION" })).toBe("INGRESO_HOSPITALIZACION");
    expect(claveDeCargo({ categoria: "URGENCIAS" })).toBe("INGRESO_URGENCIAS");
    expect(claveDeCargo({ categoria: "QUIROFANO" })).toBe("INGRESO_QUIROFANO");
    expect(claveDeCargo({ categoria: "PROCEDIMIENTO" })).toBe("INGRESO_QUIROFANO");
    expect(claveDeCargo({ categoria: "ESTUDIO" })).toBe("INGRESO_ESTUDIOS");
    expect(claveDeCargo({ categoria: "MATERIAL" })).toBe("INGRESO_MATERIAL");
    expect(claveDeCargo({ categoria: "EQUIPO" })).toBe("INGRESO_MATERIAL");
    expect(claveDeCargo({ categoria: "OTRO" })).toBe("INGRESO_OTROS");
    expect(claveDeCargo({ categoria: "HONORARIO" })).toBe("HONORARIOS_POR_CUENTA_DE_TERCEROS");
  });

  it("farmacia se parte por contexto de IVA; sin contexto, por la tasa", () => {
    expect(claveDeCargo({ categoria: "FARMACIA", ivaContexto: "SUMINISTRO_HOSPITALARIO", ivaTasa: 0.16 })).toBe("INGRESO_FARMACIA_16");
    expect(claveDeCargo({ categoria: "FARMACIA", ivaContexto: "VENTA_DIRECTA", ivaTasa: 0 })).toBe("INGRESO_FARMACIA_0");
    // El contexto manda aunque el contador haya puesto la tasa en 0 (criterio PRODECON).
    expect(claveDeCargo({ categoria: "FARMACIA", ivaContexto: "SUMINISTRO_HOSPITALARIO", ivaTasa: 0 })).toBe("INGRESO_FARMACIA_16");
    expect(claveDeCargo({ categoria: "FARMACIA", ivaContexto: null, ivaTasa: 0.16 })).toBe("INGRESO_FARMACIA_16");
    expect(claveDeCargo({ categoria: "FARMACIA", ivaContexto: null, ivaTasa: 0 })).toBe("INGRESO_FARMACIA_0");
    expect(claveDeCargo({ categoria: "FARMACIA" })).toBe("INGRESO_FARMACIA_0");
  });
});

describe("leerConfigCuentas()", () => {
  it("toma sólo claves conocidas con códigos con forma", () => {
    const cfg = leerConfigCuentas({
      INGRESO_QUIROFANO: { cuentaSAT: " 401.03 " },
      CAJA: { subcuenta: "1010-0002-0000" },
      HONORARIOS_POR_CUENTA_DE_TERCEROS: { cuentaSAT: 5 },
      INVENTADA: { cuentaSAT: "1" },
      BANCOS: "102.02",
    });
    expect(cfg).toEqual({
      INGRESO_QUIROFANO: { cuentaSAT: "401.03", subcuenta: null },
      CAJA: { cuentaSAT: "101.01", subcuenta: "1010-0002-0000" },
    });
  });

  it("basura → mapa vacío", () => {
    expect(leerConfigCuentas(null)).toEqual({});
    expect(leerConfigCuentas([1, 2])).toEqual({});
    expect(leerConfigCuentas("x")).toEqual({});
  });
});

describe("definicionCatalogo()", () => {
  it("catálogo semilla, extras del hospital y agrupador oficial", () => {
    expect(definicionCatalogo("401.01")?.nombre).toBe("Ventas y/o servicios gravados a la tasa general");
    expect(definicionCatalogo("205.06")).toMatchObject({ cuentaSAT: "205", subcuenta: "205.06", tipo: "PASIVO", nivel: 3 });
    // No está en ningún catálogo sembrado: sale del agrupador oficial con tipo por dígito.
    expect(definicionCatalogo("401.03")).toMatchObject({ cuentaSAT: "401", subcuenta: "401.03", tipo: "INGRESO", nivel: 3 });
    expect(definicionCatalogo("206")).toMatchObject({ cuentaSAT: "206", subcuenta: null, tipo: "PASIVO", nivel: 2 });
    expect(definicionCatalogo("999.99")).toBeNull();
    expect(definicionCatalogo("4101-0001-0000")).toBeNull();
  });
});

describe("resolverCuenta() / localizarCuenta()", () => {
  it("default: la cuenta del catálogo con ese código; si falta, se crea del catálogo", async () => {
    const db = new DbFalsa().sembrar(["401.01"]);
    const ventas = await resolverCuenta(comoDb(db), "c1", "INGRESO_QUIROFANO");
    expect(ventas.id).toBe(db.cuentaPorCodigo("401.01")!.id);

    expect(db.cuentaPorCodigo("205.06")).toBeNull();
    const pasivo = await resolverCuenta(comoDb(db), "c1", "HONORARIOS_POR_CUENTA_DE_TERCEROS");
    expect(pasivo).toMatchObject({ cuentaSAT: "205", subcuenta: "205.06", tipo: "PASIVO" });
    expect(db.cuentaPorCodigo("205.06")!.id).toBe(pasivo.id);
    // Segunda vez: la misma, no otra.
    expect((await resolverCuenta(comoDb(db), "c1", "HONORARIOS_POR_CUENTA_DE_TERCEROS")).id).toBe(pasivo.id);
    expect(db.cuentas.filter((c) => c.subcuenta === "205.06")).toHaveLength(1);
  });

  it("CONFIG: el código configurado manda sobre el default (y se crea del agrupador si hace falta)", async () => {
    const db = new DbFalsa().sembrar(["401.01"]);
    const c = await resolverCuenta(comoDb(db), "c1", "INGRESO_QUIROFANO", { config: { INGRESO_QUIROFANO: { cuentaSAT: "401.03" } } });
    expect(c.subcuenta).toBe("401.03");
    expect(c.nombre).toBe(CODIGO_AGRUPADOR_OFICIAL["401.03"]);
  });

  it("CONFIG con subcuenta: la cuenta propia del catálogo de la empresa", async () => {
    const db = new DbFalsa();
    db.cuentas.push({ id: "propia", companyId: "c1", cuentaSAT: "4101-0003-0000", subcuenta: null, nombre: "VENTA QUIROFANO", tipo: "INGRESO", nivel: 3, naturaleza: null, codAgrup: null, isActive: true, createdAt: new Date() });
    const c = await resolverCuenta(comoDb(db), "c1", "INGRESO_QUIROFANO", { config: { INGRESO_QUIROFANO: { cuentaSAT: "401.01", subcuenta: "4101-0003-0000" } } });
    expect(c.id).toBe("propia");
  });

  it("OVERRIDE hospital:<clave> gana sobre todo; inactivo se ignora", async () => {
    const db = new DbFalsa().sembrar(["401.01"]);
    db.cuentas.push({ id: "elegida", companyId: "c1", cuentaSAT: "4101-0009-0000", subcuenta: null, nombre: "VENTA HOSPITAL", tipo: "INGRESO", nivel: 3, naturaleza: null, codAgrup: null, isActive: true, createdAt: new Date() });
    db.overrides.push({ id: "o1", companyId: "c1", codigoMotor: codigoMotorDe("INGRESO_HOSPITALIZACION"), chartAccountId: "elegida" });
    expect((await resolverCuenta(comoDb(db), "c1", "INGRESO_HOSPITALIZACION", { config: { INGRESO_HOSPITALIZACION: { cuentaSAT: "401.03" } } })).id).toBe("elegida");

    db.cuentas.find((c) => c.id === "elegida")!.isActive = false;
    expect((await resolverCuenta(comoDb(db), "c1", "INGRESO_HOSPITALIZACION")).id).toBe(db.cuentaPorCodigo("401.01")!.id);
  });

  it("plan propio: el codAgrup único invierte al plan de la empresa, como el motor", async () => {
    const db = new DbFalsa();
    db.cuentas.push({ id: "p1", companyId: "c1", cuentaSAT: "1050-0001-0000", subcuenta: null, nombre: "CLIENTES", tipo: "ACTIVO", nivel: 3, naturaleza: null, codAgrup: "105.01", isActive: true, createdAt: new Date() });
    expect((await localizarCuenta(comoDb(db), "c1", "105.01"))?.id).toBe("p1");
    // Ambiguo → no se adivina: cae al código del SAT (se crea).
    db.cuentas.push({ id: "p2", companyId: "c1", cuentaSAT: "1050-0002-0000", subcuenta: null, nombre: "CLIENTES EXTRANJERO", tipo: "ACTIVO", nivel: 3, naturaleza: null, codAgrup: "105.01", isActive: true, createdAt: new Date() });
    expect(await localizarCuenta(comoDb(db), "c1", "105.01")).toBeNull();
    expect((await resolverCuenta(comoDb(db), "c1", "CLIENTES")).subcuenta).toBe("105.01");
  });
});

const propia = (over: { id: string; cuentaSAT: string; nombre: string; nivel?: number; codAgrup?: string | null }) => ({
  id: over.id, companyId: "c1", cuentaSAT: over.cuentaSAT, subcuenta: null, nombre: over.nombre,
  tipo: "ACTIVO" as const, nivel: over.nivel ?? 3, naturaleza: null, codAgrup: over.codAgrup ?? null, isActive: true, createdAt: new Date(),
});

describe("plan propio: la acumulativa no compite con sus hijas", () => {
  it("mayor y subcuenta con el mismo agrupador → gana la de detalle, no el stub del SAT", async () => {
    const db = new DbFalsa();
    // Como lo trae un CT real: «205006000 Otros acreedores diversos» y su única
    // hija. Contadas como dos candidatas, el código se iba al stub 205.06.
    db.cuentas.push(propia({ id: "mayor", cuentaSAT: "205006000", nombre: "Otros acreedores diversos", nivel: 2, codAgrup: "205.06" }));
    db.cuentas.push(propia({ id: "hoja", cuentaSAT: "205006001", nombre: "Otros acreedores diversos", nivel: 3, codAgrup: "205.06" }));
    expect((await localizarCuenta(comoDb(db), "c1", "205.06"))?.id).toBe("hoja");
    expect((await resolverCuenta(comoDb(db), "c1", "HONORARIOS_POR_CUENTA_DE_TERCEROS")).id).toBe("hoja");
  });
});

describe("mapaCuentas()", () => {
  it("origen DEFAULT / CONFIG / OVERRIDE y la cuenta que hoy recibiría el asiento (sin crear)", async () => {
    const db = new DbFalsa().sembrar(["401.01", "101.01"]);
    db.configRow = { contabilidadActiva: false, cuentasContables: { INGRESO_QUIROFANO: { cuentaSAT: "401.03" } } };
    db.cuentas.push({ id: "elegida", companyId: "c1", cuentaSAT: "1020-0001-0000", subcuenta: null, nombre: "BANCOMER", tipo: "ACTIVO", nivel: 3, naturaleza: null, codAgrup: null, isActive: true, createdAt: new Date() });
    db.overrides.push({ id: "o1", companyId: "c1", codigoMotor: codigoMotorDe("CAJA"), chartAccountId: "elegida" });

    const mapa = await mapaCuentas(comoDb(db), "c1");
    expect(mapa.activa).toBe(false);
    expect(mapa.claves).toHaveLength(CLAVES_MOTOR.length);
    const por = Object.fromEntries(mapa.claves.map((r) => [r.clave, r]));
    expect(por.INGRESO_HOSPITALIZACION).toMatchObject({ origen: "DEFAULT", cuentaSAT: "401.01", cuenta: { codigo: "401.01" } });
    expect(por.INGRESO_QUIROFANO).toMatchObject({ origen: "CONFIG", cuentaSAT: "401.03", cuenta: null });
    expect(por.CAJA).toMatchObject({ origen: "OVERRIDE", subcuenta: "1020-0001-0000", cuenta: { id: "elegida", nombre: "BANCOMER" } });
    expect(por.HONORARIOS_POR_CUENTA_DE_TERCEROS.cuenta).toBeNull();
    // Mirar no crea nada.
    expect(db.cuentaPorCodigo("205.06")).toBeNull();
    expect(db.cuentaPorCodigo("401.03")).toBeNull();
  });

  it("varias candidatas del plan propio: las enseña y propone la del servicio de la clave", async () => {
    const db = new DbFalsa();
    db.cuentas.push(propia({ id: "acum", cuentaSAT: "115001000", nombre: "Almacenes", nivel: 2, codAgrup: "115.01" }));
    db.cuentas.push(propia({ id: "externa", cuentaSAT: "115001003", nombre: "Almacen Farmacia Externa", codAgrup: "115.01" }));
    db.cuentas.push(propia({ id: "interna", cuentaSAT: "115001006", nombre: "Almacen Farmacia Intrahospitalaria", codAgrup: "115.01" }));
    db.cuentas.push(propia({ id: "quirofano", cuentaSAT: "115001007", nombre: "Almacen Quirofano", codAgrup: "115.01" }));

    const inv = (await mapaCuentas(comoDb(db), "c1")).claves.find((r) => r.clave === "INVENTARIO_FARMACIA")!;
    // La acumulativa no es candidata: no recibe pólizas.
    expect(inv.candidatas.map((c) => c.id).sort()).toEqual(["externa", "interna", "quirofano"]);
    expect(inv.sugerencia).toMatchObject({ confianza: "EXACTA", cuenta: { id: "interna" } });
    // Sin decidir, el asiento seguiría cayendo en el stub del SAT: por eso se propone.
    expect(inv.cuenta).toBeNull();
    expect(inv.origen).toBe("DEFAULT");
  });

  it("decidida (override) ya no se propone", async () => {
    const db = new DbFalsa();
    db.cuentas.push(propia({ id: "externa", cuentaSAT: "115001003", nombre: "Almacen Farmacia Externa", codAgrup: "115.01" }));
    db.cuentas.push(propia({ id: "interna", cuentaSAT: "115001006", nombre: "Almacen Farmacia Intrahospitalaria", codAgrup: "115.01" }));
    db.overrides.push({ id: "o1", companyId: "c1", codigoMotor: codigoMotorDe("INVENTARIO_FARMACIA"), chartAccountId: "externa" });

    const inv = (await mapaCuentas(comoDb(db), "c1")).claves.find((r) => r.clave === "INVENTARIO_FARMACIA")!;
    expect(inv.origen).toBe("OVERRIDE");
    expect(inv.cuenta?.id).toBe("externa");
    expect(inv.sugerencia).toBeNull();
    // Las candidatas se siguen enseñando: cambiar de opinión es un clic.
    expect(inv.candidatas).toHaveLength(2);
  });
});
