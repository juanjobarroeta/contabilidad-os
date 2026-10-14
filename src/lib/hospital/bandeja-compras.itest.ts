import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { cerrarFaltante, cerrarLineas, crearSolicitudArea, lineasArea, marcarPedidoEnviado, requisicionarLineas } from "./bandeja-compras";
import { aprobarRequisicion, cancelarRequisicion, recibirManual } from "./requisiciones";

const skip = process.env.DB_TESTS_SKIP === "1";

describe.skipIf(skip)("bandeja de compras: del área al pedido y lo que no surtieron", () => {
  let companyId = "";
  let proveedorA = "";
  let proveedorB = "";
  const compras = "u-compras";
  const director = "u-director";

  beforeAll(async () => {
    const c = await prisma.company.create({
      data: { rfc: `BAN${Date.now() % 1000000}AA1`, razonSocial: "Hospital bandeja iTest", regimenFiscal: "601", codigoPostal: "72000" },
    });
    companyId = c.id;
    proveedorA = (await prisma.supplier.create({ data: { companyId, rfc: "PRA010101AA1", razonSocial: "PROVEEDOR A" } })).id;
    proveedorB = (await prisma.supplier.create({ data: { companyId, rfc: "PRB010101AA1", razonSocial: "PROVEEDOR B" } })).id;
  });

  afterAll(async () => {
    await prisma.hospSolicitudArea.deleteMany({ where: { companyId } });
    await prisma.solicitudAdjudicacion.deleteMany({ where: { companyId } });
    await prisma.solicitudCotizacionPartida.deleteMany({ where: { cotizacion: { solicitud: { companyId } } } });
    await prisma.solicitudCompra.deleteMany({ where: { companyId } });
    await prisma.supplier.deleteMany({ where: { companyId } });
    await prisma.company.delete({ where: { id: companyId } });
    await prisma.$disconnect();
  });

  const bandeja = () => lineasArea(prisma, companyId, { soloBandeja: true });

  it("el área pide sin proveedor y cae en la bandeja con su urgencia", async () => {
    const s = await crearSolicitudArea(companyId, { id: "u-area", nombre: "Enfermería" }, {
      area: "Hospitalización",
      urgencia: "SEMIURGENTE",
      lineas: [
        { descripcion: "Guantes de látex caja", unidad: "caja", cantidad: 10 },
        { descripcion: "Cubrebocas tricapa", unidad: "caja", cantidad: 4, urgencia: "URGENTE" },
      ],
    });
    expect(s.folio).toMatch(/^SA-\d{4}-0001$/);
    const b = await bandeja();
    expect(b.map((l) => [l.descripcion, l.urgencia, l.estado])).toEqual([
      ["Cubrebocas tricapa", "URGENTE", "EN_BANDEJA"],
      ["Guantes de látex caja", "SEMIURGENTE", "EN_BANDEJA"],
    ]);
  });

  it("compras arma la requisición; si se cancela, las líneas regresan a la bandeja", async () => {
    const b = await bandeja();
    const r = await requisicionarLineas(companyId, compras, {
      lineas: b.map((l) => ({ lineaId: l.id, cantidad: l.cantidad })),
      cotizaciones: [{ supplierId: proveedorA, precios: b.map((l) => ({ lineaId: l.id, precioUnitario: 100 })) }],
    });
    expect(await bandeja()).toHaveLength(0);
    const todas = await lineasArea(prisma, companyId, {});
    expect(todas.every((l) => l.estado === "POR_AUTORIZAR" && l.requisicion?.folio === r.folio)).toBe(true);
    // Dos compradores no se llevan la misma línea.
    await expect(
      requisicionarLineas(companyId, compras, { lineas: [{ lineaId: b[0].id, cantidad: 1 }], cotizaciones: [{ supplierId: proveedorB, precios: [{ lineaId: b[0].id, precioUnitario: 1 }] }] })
    ).rejects.toThrow(/otra requisición/);

    await cancelarRequisicion(r.id, companyId);
    expect(await bandeja()).toHaveLength(2);
  });

  it("autorizada, pedida y con faltante: la orden se cierra en lo recibido y lo demás regresa", async () => {
    const b = await bandeja();
    const guantes = b.find((l) => l.descripcion.startsWith("Guantes"))!;
    const cubrebocas = b.find((l) => l.descripcion.startsWith("Cubrebocas"))!;
    const r = await requisicionarLineas(companyId, compras, {
      lineas: [{ lineaId: guantes.id, cantidad: 10 }, { lineaId: cubrebocas.id, cantidad: 4 }],
      cotizaciones: [{ supplierId: proveedorA, precios: [{ lineaId: guantes.id, precioUnitario: 50 }, { lineaId: cubrebocas.id, precioUnitario: 80 }] }],
    });
    const { ordenes } = await aprobarRequisicion(r.id, companyId, director);
    expect(ordenes).toHaveLength(1);
    await marcarPedidoEnviado(ordenes[0].id, companyId, compras, "WHATSAPP");
    let todas = await lineasArea(prisma, companyId, {});
    expect(todas.find((l) => l.id === guantes.id)?.estado).toBe("PEDIDA");

    const partidaGuantes = todas.find((l) => l.id === guantes.id)!.partida!.id;
    await recibirManual(partidaGuantes, companyId, 6);
    todas = await lineasArea(prisma, companyId, {});
    expect(todas.find((l) => l.id === guantes.id)?.estado).toBe("PARCIAL");

    const f = await cerrarFaltante(partidaGuantes, companyId, compras, "REENVIAR", "sólo traía 6");
    expect(f).toMatchObject({ falta: 4, ordenCancelada: false });
    const partida = await prisma.solicitudPartida.findUniqueOrThrow({ where: { id: partidaGuantes } });
    expect([Number(partida.cantidad), Number(partida.importe)]).toEqual([6, 300]);
    const orden = await prisma.solicitudAdjudicacion.findFirstOrThrow({ where: { solicitudId: r.id } });
    expect(Number(orden.total)).toBe(620); // 6×50 + 4×80

    const [regreso] = await bandeja();
    expect(regreso).toMatchObject({ id: guantes.id, cantidad: 4, surtidoPrevio: 6, intentos: 1, proveedoresIntentados: ["PROVEEDOR A"] });
  });

  it("lo que no se consigue se cierra por desabasto y sale de la bandeja", async () => {
    const [l] = await bandeja();
    await cerrarLineas(companyId, compras, [l.id], "DESABASTO", "sin existencia con ningún distribuidor");
    expect(await bandeja()).toHaveLength(0);
    const todas = await lineasArea(prisma, companyId, {});
    expect(todas.find((x) => x.id === l.id)?.estado).toBe("DESABASTO");
  });

  it("faltante total de una orden de una sola línea: la requisición se cancela", async () => {
    const s = await crearSolicitudArea(companyId, { id: "u-area", nombre: null }, { area: "Quirófano", lineas: [{ descripcion: "Sutura vicryl", cantidad: 2 }] });
    const linea = (await bandeja()).find((x) => x.solicitud.folio === s.folio)!;
    const r = await requisicionarLineas(companyId, compras, { lineas: [{ lineaId: linea.id, cantidad: 2 }], cotizaciones: [{ supplierId: proveedorB, precios: [{ lineaId: linea.id, precioUnitario: 300 }] }] });
    await aprobarRequisicion(r.id, companyId, director);
    const partidaId = (await prisma.solicitudPartida.findFirstOrThrow({ where: { solicitudId: r.id } })).id;
    const f = await cerrarFaltante(partidaId, companyId, compras, "REENVIAR", "");
    expect(f.ordenCancelada).toBe(true);
    expect((await prisma.solicitudCompra.findUniqueOrThrow({ where: { id: r.id } })).estado).toBe("CANCELADA");
    expect((await bandeja()).map((x) => x.id)).toContain(linea.id);
  });

  it("varios proveedores: gana el más barato por línea, quien autoriza cambia una y sale una orden por proveedor", async () => {
    const s = await crearSolicitudArea(companyId, { id: "u-area", nombre: null }, {
      area: "Urgencias", proveedorSugeridoId: proveedorB,
      lineas: [{ descripcion: "Jeringa 5 ml", cantidad: 100 }, { descripcion: "Gasa estéril", cantidad: 50 }, { descripcion: "Venda elástica", cantidad: 20 }],
    });
    const lineas = (await bandeja()).filter((x) => x.solicitud.folio === s.folio);
    expect(lineas.every((l) => l.proveedorSugerido?.razonSocial === "PROVEEDOR B")).toBe(true);
    const [jeringa, gasa, venda] = ["Jeringa", "Gasa", "Venda"].map((t) => lineas.find((l) => l.descripcion.startsWith(t))!);

    const r = await requisicionarLineas(companyId, compras, {
      lineas: [jeringa, gasa, venda].map((l) => ({ lineaId: l.id, cantidad: l.cantidad })),
      cotizaciones: [
        { supplierId: proveedorA, diasEntrega: 2, precios: [{ lineaId: jeringa.id, precioUnitario: 3 }, { lineaId: gasa.id, precioUnitario: 10 }] },
        { supplierId: proveedorB, tieneCredito: true, diasCredito: 30, precios: [{ lineaId: jeringa.id, precioUnitario: 4 }, { lineaId: gasa.id, precioUnitario: 8 }, { lineaId: venda.id, precioUnitario: 25 }] },
      ],
    });
    // Más barato por línea: jeringa → A (3), gasa → B (8), venda → B (único).
    expect(r.total).toBe(100 * 3 + 50 * 8 + 20 * 25);

    const partidas = await prisma.solicitudPartida.findMany({ where: { solicitudId: r.id }, include: { cotizacionGanadora: true } });
    const de = (t: string) => partidas.find((p) => p.descripcion.startsWith(t))!;
    expect(de("Jeringa").cotizacionGanadora?.supplierId).toBe(proveedorA);
    expect(de("Gasa").cotizacionGanadora?.supplierId).toBe(proveedorB);

    // Quien autoriza manda la jeringa también a B (un solo proveedor para casi todo).
    const cotB = de("Gasa").cotizacionGanadoraId!;
    const { ordenes } = await aprobarRequisicion(r.id, companyId, director, { [de("Jeringa").id]: cotB });
    expect(ordenes).toHaveLength(1);
    const orden = await prisma.solicitudAdjudicacion.findFirstOrThrow({ where: { solicitudId: r.id } });
    expect([orden.supplierId, Number(orden.total), orden.tieneCredito]).toEqual([proveedorB, 100 * 4 + 50 * 8 + 20 * 25, true]);
  });

  it("dos órdenes: cada una con sus líneas, su pedido y su faltante", async () => {
    const s = await crearSolicitudArea(companyId, { id: "u-area", nombre: null }, { area: "CEYE", lineas: [{ descripcion: "Campo quirúrgico", cantidad: 10 }, { descripcion: "Cinta testigo", cantidad: 5 }] });
    const ls = (await bandeja()).filter((x) => x.solicitud.folio === s.folio);
    const lc = ls.find((l) => l.descripcion.startsWith("Campo"))!;
    const lt = ls.find((l) => l.descripcion.startsWith("Cinta"))!;
    const r = await requisicionarLineas(companyId, compras, {
      lineas: [{ lineaId: lc.id, cantidad: 10 }, { lineaId: lt.id, cantidad: 5 }],
      cotizaciones: [
        { supplierId: proveedorA, precios: [{ lineaId: lc.id, precioUnitario: 20 }] },
        { supplierId: proveedorB, precios: [{ lineaId: lt.id, precioUnitario: 40 }] },
      ],
    });
    const { ordenes } = await aprobarRequisicion(r.id, companyId, director);
    expect(ordenes).toHaveLength(2);
    const ordA = await prisma.solicitudAdjudicacion.findFirstOrThrow({ where: { solicitudId: r.id, supplierId: proveedorA } });
    const ordB = await prisma.solicitudAdjudicacion.findFirstOrThrow({ where: { solicitudId: r.id, supplierId: proveedorB } });
    expect([Number(ordA.total), Number(ordB.total)]).toEqual([200, 200]);

    await marcarPedidoEnviado(ordA.id, companyId, compras, "CORREO");
    let todas = await lineasArea(prisma, companyId, {});
    expect(todas.find((l) => l.id === lc.id)?.estado).toBe("PEDIDA");
    expect(todas.find((l) => l.id === lt.id)?.estado).toBe("POR_ENVIAR");
    expect(todas.find((l) => l.id === lt.id)?.requisicion?.proveedor?.razonSocial).toBe("PROVEEDOR B");

    // B no surtió nada: su orden se quita, la de A sigue intacta y la cinta regresa a la bandeja.
    const pCinta = (await prisma.solicitudPartida.findFirstOrThrow({ where: { solicitudId: r.id, descripcion: { startsWith: "Cinta" } } })).id;
    const f = await cerrarFaltante(pCinta, companyId, compras, "REENVIAR", "");
    expect(f).toMatchObject({ ordenCancelada: false, ordenProveedorCancelada: true });
    expect(await prisma.solicitudAdjudicacion.count({ where: { solicitudId: r.id } })).toBe(1);
    expect(Number((await prisma.solicitudAdjudicacion.findUniqueOrThrow({ where: { id: ordA.id } })).total)).toBe(200);
    todas = await lineasArea(prisma, companyId, { soloBandeja: true });
    expect(todas.find((l) => l.id === lt.id)).toMatchObject({ intentos: 1, proveedoresIntentados: ["PROVEEDOR B"] });
  });
});
