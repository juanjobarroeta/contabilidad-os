import { describe, expect, it } from "vitest";
import {
  agruparFacturasEnEpisodios,
  cargosDeFactura,
  derivarEpisodiosDeCfdi,
  ivaTasaDeConcepto,
  referenciaCfdi,
  resolverPacienteDeFactura,
  tipoDePagador,
  tipoEpisodioPorConceptos,
} from "./episodios-cfdi";

// Mediodía en el reloj de piso (America/Mexico_City): las ventanas se miden
// en días locales, no en horas.
const dia = (iso: string) => new Date(`${iso}T18:00:00.000Z`);

// ─── Tipo de episodio ────────────────────────────────────────────────────────

describe("tipoEpisodioPorConceptos()", () => {
  it("hospitalización manda sobre todo lo demás", () => {
    expect(tipoEpisodioPorConceptos(["HOSPITALIZACION", "QUIROFANO", "FARMACIA HOSPITALARIA 16"])).toBe("HOSPITALIZACION");
    expect(tipoEpisodioPorConceptos(["Servicios hospitalarios PX Jessica Guadalupe Barranco Lima"])).toBe("HOSPITALIZACION");
    expect(tipoEpisodioPorConceptos(["HABITACION ESTANDAR", "URGENCIAS"])).toBe("HOSPITALIZACION");
  });

  it("«farmacia hospitalaria» es el área, no una estancia", () => {
    expect(tipoEpisodioPorConceptos(["FARMACIA HOSPITALARIA 16", "FARMACIA HOSPITALARIA 0"])).toBe("CONSULTA");
    expect(tipoEpisodioPorConceptos(["FARMACIA HOSPITALARIA 16", "LABORATORIO CLINICO"])).toBe("CONSULTA");
  });

  it("urgencias antes que ambulatorio", () => {
    expect(tipoEpisodioPorConceptos(["URGENCIAS", "RAYOS X"])).toBe("URGENCIAS");
    expect(tipoEpisodioPorConceptos(["URGENCIAS", "QUIROFANO"])).toBe("URGENCIAS");
  });

  it("quirófano, endoscopia, cirugía, biopsia y paquetes son ambulatorio", () => {
    expect(tipoEpisodioPorConceptos(["QUIROFANO", "RECUPERACION POSTQUIRURGICA"])).toBe("AMBULATORIO");
    expect(tipoEpisodioPorConceptos(["ENDOSCOPIA"])).toBe("AMBULATORIO");
    expect(tipoEpisodioPorConceptos(["PAQUETES"])).toBe("AMBULATORIO");
    expect(tipoEpisodioPorConceptos(["NC EXCENDETE DE BIOPSIA (PX MARIA GUADALUPE TAMBURRINO VARGAS)"])).toBe("AMBULATORIO");
    expect(tipoEpisodioPorConceptos(["Cistoscopia, paciente Héctor Rogelio Aguilera Vázquez"])).toBe("AMBULATORIO");
  });

  it("lo que no dice nada es consulta", () => {
    expect(tipoEpisodioPorConceptos(["PATOLOGIA", "LABORATORIO CLINICO"])).toBe("CONSULTA");
    expect(tipoEpisodioPorConceptos([])).toBe("CONSULTA");
    expect(tipoEpisodioPorConceptos([null, undefined, ""])).toBe("CONSULTA");
  });
});

// ─── Agrupación ──────────────────────────────────────────────────────────────

describe("agruparFacturasEnEpisodios()", () => {
  const f = (id: string, pacienteKey: string, iso: string) => ({ id, pacienteKey, fecha: dia(iso) });

  it("dos CFDIs del mismo paciente con dos días de diferencia son UNA atención", () => {
    const grupos = agruparFacturasEnEpisodios([f("a", "p1", "2026-08-29"), f("b", "p1", "2026-08-31")]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].map((g) => g.id)).toEqual(["a", "b"]);
  });

  it("más de la ventana abre otro episodio", () => {
    const grupos = agruparFacturasEnEpisodios([f("a", "p1", "2026-08-01"), f("b", "p1", "2026-08-20")]);
    expect(grupos).toHaveLength(2);
  });

  it("justo en la ventana sigue siendo el mismo; un día más, no", () => {
    expect(agruparFacturasEnEpisodios([f("a", "p1", "2026-08-01"), f("b", "p1", "2026-08-08")])).toHaveLength(1);
    expect(agruparFacturasEnEpisodios([f("a", "p1", "2026-08-01"), f("b", "p1", "2026-08-09")])).toHaveLength(2);
  });

  it("la ventana se mide contra la última factura del grupo (estancia facturada en partes)", () => {
    const grupos = agruparFacturasEnEpisodios([
      f("a", "p1", "2026-08-01"),
      f("b", "p1", "2026-08-07"),
      f("c", "p1", "2026-08-13"),
    ]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0]).toHaveLength(3);
  });

  it("cada paciente por su lado, y los grupos salen por fecha", () => {
    const grupos = agruparFacturasEnEpisodios([
      f("a", "p2", "2026-08-10"),
      f("b", "p1", "2026-08-01"),
      f("c", "p2", "2026-08-11"),
    ]);
    expect(grupos.map((g) => g.map((x) => x.id))).toEqual([["b"], ["a", "c"]]);
  });

  it("respeta una ventana distinta", () => {
    expect(agruparFacturasEnEpisodios([f("a", "p1", "2026-08-01"), f("b", "p1", "2026-08-03")], { diasVentana: 1 })).toHaveLength(2);
  });
});

// ─── Paciente ────────────────────────────────────────────────────────────────

const items = (...descripciones: string[]) => descripciones.map((descripcion) => ({ descripcion }));

describe("resolverPacienteDeFactura()", () => {
  it("receptor persona física con conceptos de área: el paciente es el receptor", () => {
    const r = resolverPacienteDeFactura({
      customerId: "cus1",
      receptorRfc: "JITR850214HN3",
      receptorNombre: "RAFAEL JIMENEZ TORRES",
      items: items("HOSPITALIZACION", "FARMACIA HOSPITALARIA 16", "QUIROFANO"),
    });
    expect(r).toMatchObject({
      modo: "RECEPTOR",
      nombre: "Rafael",
      apellidoPaterno: "Jimenez",
      apellidoMaterno: "Torres",
      customerId: "cus1",
      llave: "RAFAEL JIMENEZ TORRES",
    });
  });

  it("receptor persona moral: el nombre sale de los conceptos y el convenio se queda con el RFC", () => {
    const r = resolverPacienteDeFactura({
      customerId: "cusPlan",
      receptorRfc: "PSE901231AB2",
      receptorNombre: "PLAN SEGURO SA DE CV",
      items: items("Hospitalización px Rafael Jiménez Torres"),
    });
    expect(r).toMatchObject({ modo: "CONCEPTO", nombre: "Rafael", apellidoPaterno: "Jimenez", apellidoMaterno: "Torres" });
    // El paciente NO es cliente de la aseguradora: su receptor fiscal queda vacío.
    expect(r.customerId).toBeNull();
  });

  it("persona física cuyo concepto nombra a otro (el padre paga por el hijo): manda el concepto, con su RFC", () => {
    const r = resolverPacienteDeFactura({
      customerId: "cus9",
      receptorRfc: "MOBJ760101AB1",
      receptorNombre: "JUAN MONTES BERRA",
      items: items("Estudio inmunohistoquímica, paciente Mercedes Montagner Berra."),
    });
    expect(r).toMatchObject({ modo: "CONCEPTO", nombre: "Mercedes", apellidoPaterno: "Montagner", apellidoMaterno: "Berra", customerId: "cus9" });
  });

  it("empresa sin nombre en los conceptos: sin paciente, con motivo", () => {
    const r = resolverPacienteDeFactura({
      customerId: "cusRadix",
      receptorRfc: "RME1201019J8",
      receptorNombre: "RADIX MED SA DE CV",
      items: items("SERVICIOS HOSPITALARIOS DEL MES"),
    });
    expect(r.modo).toBe("SIN_NOMBRE");
    expect(r.motivo).toContain("RADIX MED");
  });

  it("público en general y extranjero no son un paciente", () => {
    expect(resolverPacienteDeFactura({ customerId: null, receptorRfc: "XAXX010101000", receptorNombre: "PUBLICO EN GENERAL", items: items("URGENCIAS") }).modo).toBe("SIN_NOMBRE");
    expect(resolverPacienteDeFactura({ customerId: null, receptorRfc: "XEXX010101000", receptorNombre: "JOHN DOE", items: items("URGENCIAS") }).modo).toBe("SIN_NOMBRE");
  });

  it("público en general con el paciente en el concepto sí se puede", () => {
    const r = resolverPacienteDeFactura({
      customerId: null,
      receptorRfc: "XAXX010101000",
      receptorNombre: "PUBLICO EN GENERAL",
      items: items("Consulta paciente Juan Bernardino Ramirez Nava"),
    });
    expect(r).toMatchObject({ modo: "CONCEPTO", nombre: "Juan Bernardino", apellidoPaterno: "Ramirez", apellidoMaterno: "Nava", customerId: null });
  });

  it("sin receptor ni nombre en el concepto no hay nada que hacer", () => {
    const r = resolverPacienteDeFactura({ customerId: null, receptorRfc: null, receptorNombre: null, items: items("URGENCIAS") });
    expect(r.modo).toBe("SIN_NOMBRE");
    expect(r.motivo).toContain("receptor");
  });
});

// ─── Cargos ──────────────────────────────────────────────────────────────────

describe("cargosDeFactura()", () => {
  const factura = {
    id: "inv1",
    fecha: dia("2026-08-29"),
    subtotal: 11000,
    totalImpuestos: 1600,
    items: [
      { descripcion: "HOSPITALIZACION", cantidad: 2, valorUnitario: 5000, importe: 10000 },
      { descripcion: "FARMACIA HOSPITALARIA 0", cantidad: 1, valorUnitario: 500, importe: 500 },
      { descripcion: "FARMACIA HOSPITALARIA 16", cantidad: 1, valorUnitario: 500, importe: 500 },
    ],
  };

  it("un cargo por concepto, con categoría, cantidad, precio, importe y su CFDI", () => {
    const cargos = cargosDeFactura(factura);
    expect(cargos).toHaveLength(3);
    expect(cargos[0]).toEqual({
      categoria: "HABITACION",
      descripcion: "HOSPITALIZACION",
      cantidad: 2,
      precioUnitario: 5000,
      importe: 10000,
      ivaTasa: 0.16,
      origen: "CFDI",
      invoiceId: "inv1",
      fecha: factura.fecha,
    });
  });

  it("el sufijo de la descripción fija la tasa del renglón", () => {
    const cargos = cargosDeFactura(factura);
    expect(cargos[1]).toMatchObject({ categoria: "FARMACIA", ivaTasa: 0 });
    expect(cargos[2]).toMatchObject({ categoria: "FARMACIA", ivaTasa: 0.16 });
  });

  it("saca el precio unitario del importe cuando el CFDI no lo trae", () => {
    const cargos = cargosDeFactura({ id: "i", fecha: dia("2026-08-29"), items: [{ descripcion: "PAQUETES", cantidad: 4, importe: 1000 }] });
    expect(cargos[0]).toMatchObject({ precioUnitario: 250, cantidad: 4, categoria: "PROCEDIMIENTO" });
  });

  it("ignora los renglones vacíos", () => {
    expect(cargosDeFactura({ id: "i", fecha: dia("2026-08-29"), items: [{ descripcion: "", importe: 0 }] })).toHaveLength(0);
  });
});

describe("ivaTasaDeConcepto()", () => {
  it("el CFDI todo gravado al 16 % contagia a sus renglones", () => {
    expect(ivaTasaDeConcepto("QUIROFANO", "QUIROFANO", 0.16)).toBe(0.16);
    expect(ivaTasaDeConcepto("FARMACIA HOSPITALARIA", "FARMACIA", 0.16)).toBe(0.16);
  });

  it("el CFDI sin IVA deja los renglones a tasa 0 (y los honorarios exentos)", () => {
    expect(ivaTasaDeConcepto("LABORATORIO CLINICO", "ESTUDIO", 0)).toBe(0);
    expect(ivaTasaDeConcepto("HONORARIOS MEDICOS", "HONORARIO", 0)).toBeNull();
  });

  it("con tasas mezcladas manda el default de la categoría", () => {
    expect(ivaTasaDeConcepto("PATOLOGIA", "ESTUDIO", 0.08)).toBe(0.16);
    expect(ivaTasaDeConcepto("MEDICAMENTOS", "FARMACIA", 0.08)).toBe(0);
    expect(ivaTasaDeConcepto("HONORARIOS MEDICOS", "HONORARIO", 0.08)).toBeNull();
  });

  it("el sufijo gana siempre", () => {
    expect(ivaTasaDeConcepto("FARMACIA HOSPITALARIA 0", "FARMACIA", 0.16)).toBe(0);
    expect(ivaTasaDeConcepto("FARMACIA HOSPITALARIA 16", "FARMACIA", 0)).toBe(0.16);
  });
});

describe("tipoDePagador() y referenciaCfdi()", () => {
  it("las aseguradoras se reconocen por el nombre", () => {
    expect(tipoDePagador("PLAN SEGURO SA DE CV")).toBe("ASEGURADORA");
    expect(tipoDePagador("GRUPO NACIONAL PROVINCIAL SAB")).toBe("EMPRESA");
    expect(tipoDePagador("SEGUROS MONTERREY NEW YORK LIFE SA DE CV")).toBe("ASEGURADORA");
    expect(tipoDePagador("AXA SEGUROS SA DE CV")).toBe("ASEGURADORA");
    expect(tipoDePagador("METLIFE MEXICO SA")).toBe("ASEGURADORA");
    expect(tipoDePagador("RADIX MED SA DE CV")).toBe("EMPRESA");
    expect(tipoDePagador("GEFARMA SA DE CV")).toBe("EMPRESA");
    expect(tipoDePagador(null)).toBe("EMPRESA");
  });

  it("el CFDI se nombra con serie-folio y, si no hay, con el UUID", () => {
    expect(referenciaCfdi({ serie: "A", folio: "1234", uuid: "abcdef12-0000", id: "inv1" })).toBe("A-1234");
    expect(referenciaCfdi({ serie: null, folio: null, uuid: "abcdef12-0000", id: "inv1" })).toBe("ABCDEF12");
    expect(referenciaCfdi({ serie: null, folio: null, uuid: null, id: "inv1" })).toBe("inv1");
  });
});

// ─── Derivación completa, con un Prisma falso ────────────────────────────────

type Fila = Record<string, any>;

/** Las tablas que toca la derivación, en memoria (mismo estilo que insumos-cfdi.test). */
interface DbFake extends Record<string, any> {
  _invoices: Fila[];
  _pacientes: Fila[];
  _pagadores: Fila[];
  _episodios: Fila[];
  _cargos: Fila[];
  _fallas: Fila[];
}

function fakeDb(): DbFake {
  const invoices: Fila[] = [];
  const pacientes: Fila[] = [];
  const pagadores: Fila[] = [];
  const episodios: Fila[] = [];
  const cargos: Fila[] = [];
  let seq = 1;
  const nuevoId = (p: string) => `${p}${seq++}`;
  /** Errores a lanzar (uno por llamada) al crear episodios: prueba de reintentos. */
  const fallas: Fila[] = [];

  const db: DbFake = {
    _invoices: invoices,
    _pacientes: pacientes,
    _pagadores: pagadores,
    _episodios: episodios,
    _cargos: cargos,
    _fallas: fallas,
    $executeRaw: async () => 0,
    $transaction: async (fn: (tx: DbFake) => Promise<unknown>) => fn(db),
    hospConfig: { findUnique: async () => null },
    invoice: {
      findMany: async ({ where, take }: Fila) => {
        let rows = invoices.filter(
          (i) =>
            i.companyId === where.companyId &&
            i.tipo === where.tipo &&
            i.status !== where.status.not &&
            (!where.OR || where.OR.some((o: Fila) => (i.tipoSat ?? null) === o.tipoSat)) &&
            (!where.hospCargos || !cargos.some((c) => c.invoiceId === i.id)) &&
            (!where.fecha?.gte || i.fecha >= where.fecha.gte) &&
            (!where.fecha?.lte || i.fecha <= where.fecha.lte) &&
            (!where.id?.gt || i.id > where.id.gt)
        );
        rows = rows.sort((a, b) => (a.id < b.id ? -1 : 1));
        return (take ? rows.slice(0, take) : rows).map((r) => ({ ...r }));
      },
    },
    hospPaciente: {
      findFirst: async ({ where }: Fila) =>
        pacientes.find(
          (p) =>
            p.companyId === where.companyId &&
            (where.customerId === undefined || p.customerId === where.customerId) &&
            (where.nombre === undefined || String(p.nombre).toLowerCase() === String(where.nombre.equals).toLowerCase()) &&
            (where.apellidoPaterno === undefined || String(p.apellidoPaterno).toLowerCase() === String(where.apellidoPaterno.equals).toLowerCase())
        ) ?? null,
      findMany: async ({ where }: Fila) =>
        pacientes
          .filter(
            (p) =>
              p.companyId === where.companyId &&
              p.pagadorId == null &&
              episodios.some((e) => e.pacienteId === p.id && e.origen === "CFDI" && e.pagadorId != null)
          )
          .map((p) => ({
            id: p.id,
            episodios: episodios.filter((e) => e.pacienteId === p.id && e.origen === "CFDI").map((e) => ({ pagadorId: e.pagadorId })),
          })),
      create: async ({ data }: Fila) => {
        const fila = { id: nuevoId("px"), pagadorId: null, createdAt: new Date(), ...data };
        pacientes.push(fila);
        return fila;
      },
      update: async ({ where, data }: Fila) => {
        const p = pacientes.find((x) => x.id === where.id)!;
        Object.assign(p, data);
        return p;
      },
    },
    hospPagador: {
      findFirst: async ({ where }: Fila) =>
        pagadores.find((p) => p.companyId === where.companyId && p.customerId === where.customerId) ?? null,
      create: async ({ data }: Fila) => {
        const fila = { id: nuevoId("pag"), createdAt: new Date(), ...data };
        pagadores.push(fila);
        return fila;
      },
    },
    hospEpisodio: {
      findMany: async ({ where }: Fila) =>
        episodios.filter((e) => e.companyId === where.companyId && String(e.folio).startsWith(where.folio.startsWith)).map((e) => ({ folio: e.folio })),
      create: async ({ data }: Fila) => {
        const falla = fallas.shift();
        if (falla) throw falla;
        const { cargos: nested, ...resto } = data;
        const fila = { id: nuevoId("ep"), createdAt: new Date(), ...resto };
        episodios.push(fila);
        for (const c of nested?.create ?? []) cargos.push({ id: nuevoId("cg"), episodioId: fila.id, ...c });
        return fila;
      },
    },
  };
  return db;
}

const CID = "c1";
let uid = 0;
const factura = (o: Partial<Fila> & { fecha: Date; items: Fila[] }): Fila => ({
  id: `inv${String(++uid).padStart(3, "0")}`,
  companyId: CID,
  tipo: "INGRESO",
  tipoSat: "I",
  status: "STAMPED",
  uuid: `uuid-${uid}`,
  serie: "A",
  folio: String(1000 + uid),
  subtotal: o.items.reduce((s, i) => s + Number(i.importe), 0),
  totalImpuestos: r16(o.items),
  total: 0,
  customerId: null,
  contraparteRfc: null,
  contraparteNombre: null,
  customer: null,
  ...o,
});
const r16 = (items: Fila[]) => Math.round(items.reduce((s, i) => s + Number(i.importe) * 0.16, 0) * 100) / 100;

const pf = { rfc: "JITR850214HN3", razonSocial: "RAFAEL JIMENEZ TORRES" };
const aseguradora = { rfc: "PSE901231AB2", razonSocial: "PLAN SEGURO SA DE CV" };

describe("derivarEpisodiosDeCfdi()", () => {
  function conDatos() {
    uid = 0; // folios y ids estables en cada prueba
    const db = fakeDb();
    // Estancia de un particular facturada en dos exhibiciones (29 y 31 de agosto).
    db._invoices.push(
      factura({
        fecha: dia("2026-08-29"),
        customerId: "cusPf",
        customer: pf,
        items: [
          { descripcion: "HOSPITALIZACION", cantidad: 2, valorUnitario: 5000, importe: 10000 },
          { descripcion: "QUIROFANO", cantidad: 1, valorUnitario: 8000, importe: 8000 },
        ],
      }),
      factura({
        fecha: dia("2026-08-31"),
        customerId: "cusPf",
        customer: pf,
        items: [{ descripcion: "FARMACIA HOSPITALARIA 0", cantidad: 1, valorUnitario: 1200, importe: 1200 }],
      }),
      // Aseguradora: el paciente sólo aparece en el concepto.
      factura({
        fecha: dia("2026-09-02"),
        customerId: "cusPlan",
        customer: aseguradora,
        items: [{ descripcion: "Servicios hospitalarios PX Jessica Guadalupe Barranco Lima", cantidad: 1, valorUnitario: 40000, importe: 40000 }],
      }),
      // Empresa sin nombre de paciente: no hay episodio, pero se reporta.
      factura({
        fecha: dia("2026-09-03"),
        customerId: "cusRadix",
        customer: { rfc: "RME1201019J8", razonSocial: "RADIX MED SA DE CV" },
        items: [{ descripcion: "SERVICIOS HOSPITALARIOS DEL MES", cantidad: 1, valorUnitario: 5000, importe: 5000 }],
      }),
      // Cancelada y nota de crédito: nunca entran.
      factura({ fecha: dia("2026-09-04"), status: "CANCELLED", customerId: "cusPf", customer: pf, items: [{ descripcion: "URGENCIAS", cantidad: 1, valorUnitario: 900, importe: 900 }] }),
      factura({ fecha: dia("2026-09-05"), tipoSat: "E", customerId: "cusPf", customer: pf, items: [{ descripcion: "NC URGENCIAS", cantidad: 1, valorUnitario: 900, importe: 900 }] })
    );
    return db;
  }

  it("reconstruye episodios, cargos, pacientes y convenios", async () => {
    const db = conDatos();
    const r = await derivarEpisodiosDeCfdi(db as never, CID, { esperaMs: 0 });

    expect(r.facturas).toBe(4); // la cancelada y la nota de crédito ni se leen
    expect(r.episodios).toBe(2);
    expect(r.cargos).toBe(4);
    expect(r.pacientesNuevos).toBe(2);
    expect(r.pagadoresNuevos).toBe(1);
    expect(r.sinPaciente).toHaveLength(1);
    expect(r.sinPaciente[0]).toMatchObject({ receptor: "RADIX MED SA DE CV" });
    expect(r.sinPaciente[0].motivo).toContain("ningún concepto nombra al paciente");

    // El episodio del particular: una sola atención con sus dos CFDIs.
    const ep = db._episodios.find((e) => e.tipo === "HOSPITALIZACION" && e.customerId === "cusPf")!;
    expect(ep).toMatchObject({ estado: "ALTA", origen: "CFDI", pagadorId: null, folio: "HOSP-2026-0001" });
    expect(ep.fechaIngreso).toEqual(dia("2026-08-29"));
    expect(ep.fechaAlta).toEqual(dia("2026-08-31"));
    expect(ep.notasAdmin).toBe("Reconstruido de CFDI A-1001, A-1002");
    expect(ep.medicoId ?? null).toBeNull();
    expect(ep.recursoId ?? null).toBeNull();
    expect(db._cargos.filter((c) => c.episodioId === ep.id)).toHaveLength(3);
    expect(db._cargos.filter((c) => c.episodioId === ep.id).map((c) => c.categoria).sort()).toEqual(["FARMACIA", "HABITACION", "QUIROFANO"]);
    for (const c of db._cargos) expect(c).toMatchObject({ origen: "CFDI", companyId: CID });
    expect(db._cargos.find((c) => c.categoria === "FARMACIA")).toMatchObject({ ivaTasa: 0, invoiceId: "inv002" });

    // El de la aseguradora: paciente del concepto, convenio del receptor.
    const conAseguradora = db._episodios.find((e) => e.customerId === "cusPlan")!;
    const pagador = db._pagadores[0];
    expect(pagador).toMatchObject({ nombre: "Plan Seguro SA de CV", tipo: "ASEGURADORA", plazoDias: 30, customerId: "cusPlan" });
    expect(conAseguradora).toMatchObject({ tipo: "HOSPITALIZACION", pagadorId: pagador.id, origen: "CFDI" });

    // Pacientes nuevos: el receptor persona física con su RFC, el del concepto sin él.
    const rafael = db._pacientes.find((p) => p.apellidoPaterno === "Jimenez")!;
    expect(rafael).toMatchObject({ nombre: "Rafael", apellidoMaterno: "Torres", customerId: "cusPf", sinCurp: true });
    expect(rafael.sinCurpMotivo).toContain("CFDI");
    const jessica = db._pacientes.find((p) => p.apellidoPaterno === "Barranco")!;
    expect(jessica).toMatchObject({ nombre: "Jessica Guadalupe", apellidoMaterno: "Lima", customerId: null });

    // Y hereda el convenio: todos sus episodios derivados son del mismo pagador.
    expect(jessica.pagadorId).toBe(pagador.id);
    expect(rafael.pagadorId).toBeNull();
    expect(r.pacientesConPagador).toBe(1);
  });

  it("es idempotente: la segunda corrida no crea nada", async () => {
    const db = conDatos();
    await derivarEpisodiosDeCfdi(db as never, CID, { esperaMs: 0 });
    const antes = { ep: db._episodios.length, cg: db._cargos.length, px: db._pacientes.length, pg: db._pagadores.length };
    const r2 = await derivarEpisodiosDeCfdi(db as never, CID, { esperaMs: 0 });
    expect(r2).toMatchObject({ facturas: 1, episodios: 0, cargos: 0, pacientesNuevos: 0, pagadoresNuevos: 0 });
    // La única que queda sin cargos es la de RADIX: se vuelve a reportar.
    expect(r2.sinPaciente).toHaveLength(1);
    expect({ ep: db._episodios.length, cg: db._cargos.length, px: db._pacientes.length, pg: db._pagadores.length }).toEqual(antes);
  });

  it("--dry-run no escribe nada y describe lo que haría", async () => {
    const db = conDatos();
    const lineas: string[] = [];
    const r = await derivarEpisodiosDeCfdi(db as never, CID, { dry: true, esperaMs: 0, log: (l) => lineas.push(l) });
    expect(r).toMatchObject({ episodios: 2, cargos: 4, pacientesNuevos: 2, pagadoresNuevos: 1, pacientesConPagador: 1 });
    expect(db._episodios).toHaveLength(0);
    expect(db._cargos).toHaveLength(0);
    expect(db._pacientes).toHaveLength(0);
    expect(db._pagadores).toHaveLength(0);
    expect(r.muestra).toHaveLength(2);
    expect(r.muestra[0]).toMatchObject({
      paciente: "Rafael Jimenez Torres",
      tipo: "HOSPITALIZACION",
      facturas: ["A-1001", "A-1002"],
      cargos: 3,
      pagador: null,
    });
    // 18 000 al 16 % + 1 200 a tasa 0.
    expect(r.muestra[0].total).toBe(22080);
    expect(r.muestra[1]).toMatchObject({ paciente: "Jessica Guadalupe Barranco Lima", pagador: "Plan Seguro SA de CV" });
    expect(lineas.join("\n")).toContain("4 CFDIs de ingreso sin cargos ligados");
  });

  it("reusa al paciente que ya cuelga del RFC (el bootstrap lo dio de alta desde el concepto)", async () => {
    const db = conDatos();
    db._pacientes.push({
      id: "pxViejo",
      companyId: CID,
      nombre: "Rafaelito",
      apellidoPaterno: "Jimenez",
      apellidoMaterno: "Soto",
      customerId: "cusPf",
      pagadorId: null,
      createdAt: new Date(0),
    });
    const r = await derivarEpisodiosDeCfdi(db as never, CID, { esperaMs: 0 });
    expect(r.pacientesNuevos).toBe(1); // sólo Jessica
    expect(db._episodios.find((e) => e.customerId === "cusPf")!.pacienteId).toBe("pxViejo");
  });

  it("reusa el convenio existente en vez de duplicarlo", async () => {
    const db = conDatos();
    db._pagadores.push({ id: "pagViejo", companyId: CID, customerId: "cusPlan", nombre: "Plan Seguro", tipo: "ASEGURADORA", createdAt: new Date(0) });
    const r = await derivarEpisodiosDeCfdi(db as never, CID, { esperaMs: 0 });
    expect(r.pagadoresNuevos).toBe(0);
    expect(db._pagadores).toHaveLength(1);
    expect(db._episodios.find((e) => e.customerId === "cusPlan")!.pagadorId).toBe("pagViejo");
  });

  it("acota por fechas", async () => {
    const db = conDatos();
    const r = await derivarEpisodiosDeCfdi(db as never, CID, { esperaMs: 0, desde: dia("2026-09-01") });
    expect(r.facturas).toBe(2);
    expect(r.episodios).toBe(1);
    expect(db._episodios[0].customerId).toBe("cusPlan");
  });

  it("lee por páginas y sobrevive a que el proxy corte la conexión", async () => {
    const db = conDatos();
    db._fallas.push(Object.assign(new Error("Server has closed the connection."), { code: "P1017" }));
    const lineas: string[] = [];
    let reconexiones = 0;
    const r = await derivarEpisodiosDeCfdi(db as never, CID, {
      esperaMs: 0,
      lote: 1,
      log: (l) => lineas.push(l),
      alReconectar: async () => {
        reconexiones++;
      },
    });
    expect(r.episodios).toBe(2);
    expect(reconexiones).toBe(1);
    expect(lineas.join("\n")).toContain("conexión cortada");
    expect(db._episodios).toHaveLength(2);
  });

  it("un CFDI sin conceptos no abre un episodio fantasma", async () => {
    uid = 0;
    const db = fakeDb();
    db._invoices.push(factura({ fecha: dia("2026-08-29"), customerId: "cusPf", customer: pf, items: [] }));
    const r = await derivarEpisodiosDeCfdi(db as never, CID, { esperaMs: 0 });
    expect(r.episodios).toBe(0);
    expect(r.sinPaciente[0].motivo).toContain("conceptos");
    expect(db._episodios).toHaveLength(0);
  });

  it("los folios de los episodios derivados son consecutivos y del año del CFDI", async () => {
    const db = conDatos();
    await derivarEpisodiosDeCfdi(db as never, CID, { esperaMs: 0 });
    expect(db._episodios.map((e) => e.folio)).toEqual(["HOSP-2026-0001", "HOSP-2026-0002"]);
  });
});
