/**
 * EMPRESA DEMO — Fase 3 del rediseño Piloto y pieza clave del GTM.
 *
 * Crea (o regenera) una empresa ficticia con tres meses de vida realista para
 * que TODA la superficie del producto luzca viva en un demo — sin exponer el
 * RFC de un cliente real:
 *
 *   · 2 meses cerrados: CFDIs conciliados, nómina timbrada, declaración
 *     presentada, mes POSTEADO con el motor real (subcuentas por banco,
 *     traspaso cruzado, enteramiento, IVA al flujo — todo lo de CE-CONFIABLE).
 *   · El mes anterior: declaración CALCULADA lista para presentar.
 *   · El mes en curso, A MEDIO VUELO: ~15 movimientos sin clasificar (la mesa
 *     tiene trabajo), quincena CALCULADA sin timbrar (la cola dice «Timbrar»),
 *     hallazgos del auditor en el rail del Copiloto.
 *
 * NADA se finge en la UI: los datos son ficticios, la maquinaria es la real
 * (seedChartOfAccounts + postMonth de verdad).
 *
 * Uso (apuntar DATABASE_URL al entorno deseado):
 *   DATABASE_URL=<url> ts-node --compiler-options '{"module":"CommonJS"}' \
 *     scripts/seed-empresa-demo.ts --user correo@delvendedor.com [--reset]
 *
 * Idempotente con --reset: borra la empresa demo (por su RFC fijo) y la
 * recrea desde cero. Jamás toca ninguna otra empresa.
 */

import { prisma } from "../src/lib/prisma";
import { seedChartOfAccounts } from "../src/lib/contabilidad/seed-catalog";
import { postMonth } from "../src/lib/contabilidad/posting";

// ── Identidad fija de la demo ────────────────────────────────────────────────
const DEMO_RFC = "CAL150612DM4"; // ficticio; el «DM» de la homoclave es el guiño
const DEMO_RAZON = "COMERCIALIZADORA ALTIPLANO SA DE CV";

const CLIENTES = [
  ["ACEROS DEL BAJIO SA DE CV", "ABJ080312HA1"],
  ["DISTRIBUIDORA MAREA SA DE CV", "DMA110925KT3"],
  ["GRUPO TEXTIL ORIENTE SA DE CV", "GTO050718QW2"],
  ["SERVICIOS LOGISTICOS PUMA SA DE CV", "SLP130204ZR8"],
  ["INMOBILIARIA CANTERA SA DE CV", "ICA090830PL5"],
  ["OPERADORA GASTRONOMICA NORTE SA DE CV", "OGN160419MB7"],
] as const;

const PROVEEDORES = [
  ["PAPELERA CENTRAL SA DE CV", "PCE070211AA9"],
  ["COMBUSTIBLES RIVERA SA DE CV", "CRI121108BB2"],
  ["ARRENDADORA PLAZA MAYOR SA DE CV", "APM040622CC4"],
  ["TELECOM EMPRESARIAL MX SA DE CV", "TEM150917DD6"],
  ["CONSULTORES GARCIA Y ASOCIADOS SC", "CGA100513EE8"],
  ["ENERGIA DEL ALTIPLANO SA DE CV", "EAL180226FF1"],
] as const;

const EMPLEADOS = [
  ["María Fernanda", "López", 620.5], ["José Luis", "Hernández", 480.0],
  ["Ana Karen", "Martínez", 535.75], ["Carlos", "Ramírez", 710.2],
  ["Lucía", "Torres", 458.6], ["Miguel Ángel", "Flores", 595.0],
  ["Paola", "Sánchez", 505.4], ["Ricardo", "Domínguez", 662.3],
] as const;

// LCG determinista: mismo demo cada vez, sin Math.random.
let semilla = 20260828;
const rnd = () => (semilla = (semilla * 48271) % 2147483647) / 2147483647;
const entre = (a: number, b: number) => Math.round((a + rnd() * (b - a)) * 100) / 100;
const de = <T,>(arr: readonly T[]) => arr[Math.floor(rnd() * arr.length)];

const r2 = (n: number) => Math.round(n * 100) / 100;
const CLABE_X = "012180004455667788"; // BBVA operativa
const CLABE_Y = "014180009988776655"; // Santander nómina

function fecha(y: number, m: number, d: number) {
  return new Date(Date.UTC(y, m - 1, d, 17, 0, 0));
}

function rawXmlStub(emisorRfc: string, receptorRfc: string) {
  return `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4"><cfdi:Emisor Rfc="${emisorRfc}"/><cfdi:Receptor Rfc="${receptorRfc}"/></cfdi:Comprobante>`;
}

async function borrarDemo(companyId: string) {
  const w = { where: { companyId } };
  await prisma.accountingEntry.deleteMany(w);
  await prisma.accountingPeriod.deleteMany(w);
  await prisma.conciliacionDetalle.deleteMany({ where: { bankTransaction: { companyId } } });
  await prisma.bankTransaction.deleteMany(w);
  await prisma.bankAccount.deleteMany(w);
  await prisma.pagoDoctoRelacionado.deleteMany({ where: { pagoInvoice: { companyId } } });
  await prisma.payrollItem.deleteMany({ where: { payrollRun: { companyId } } });
  await prisma.payrollRun.deleteMany(w);
  await prisma.employee.deleteMany(w);
  await prisma.invoiceTax.deleteMany({ where: { invoice: { companyId } } });
  await prisma.invoiceItem.deleteMany({ where: { invoice: { companyId } } });
  await prisma.invoice.deleteMany(w);
  await prisma.taxDeclaration.deleteMany(w);
  await prisma.fiscalHallazgo.deleteMany(w);
  await prisma.customer.deleteMany(w);
  await prisma.supplier.deleteMany(w);
  await prisma.chartAccount.deleteMany(w);
  await prisma.companyMember.deleteMany(w);
  await prisma.company.delete({ where: { id: companyId } });
}

async function main() {
  const args = process.argv.slice(2);
  const email = args.includes("--user") ? args[args.indexOf("--user") + 1] : null;
  if (!email) {
    console.error("Uso: seed-empresa-demo.ts --user <email> [--reset]");
    process.exit(2);
  }
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new Error(`Usuario ${email} no existe.`);

  const existente = await prisma.company.findFirst({ where: { rfc: DEMO_RFC }, select: { id: true } });
  if (existente) {
    if (!args.includes("--reset")) {
      throw new Error(`La empresa demo ya existe (${DEMO_RFC}). Corre con --reset para regenerarla.`);
    }
    console.log("· Borrando la demo anterior…");
    await borrarDemo(existente.id);
  }

  const hoy = new Date();
  const y = hoy.getUTCFullYear();
  const m = hoy.getUTCMonth() + 1; // mes en curso
  const mes = (off: number) => {
    const d = new Date(Date.UTC(y, m - 1 + off, 1));
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
  };
  const M1 = mes(-1); // declaración calculada, mes por postear→posteado
  const M2 = mes(-2); // cerrado
  const M3 = mes(-3); // cerrado

  console.log(`· Creando ${DEMO_RAZON} (${DEMO_RFC})…`);
  const company = await prisma.company.create({
    data: {
      rfc: DEMO_RFC,
      razonSocial: DEMO_RAZON,
      regimenFiscal: "601",
      codigoPostal: "72810",
      registroPatronal: "D5312874109",
      members: { create: { userId: user.id, role: "OWNER" } },
    },
  });
  const cid = company.id;
  await seedChartOfAccounts(cid);

  const clientes = await Promise.all(
    CLIENTES.map(([razonSocial, rfc]) =>
      prisma.customer.create({ data: { companyId: cid, razonSocial, rfc, regimenFiscal: "601" } }),
    ),
  );
  await Promise.all(
    PROVEEDORES.map(([razonSocial, rfc]) =>
      prisma.supplier.create({ data: { companyId: cid, razonSocial, rfc } }),
    ),
  );

  const empleados = await Promise.all(
    EMPLEADOS.map(([nombre, apellidoPaterno, salarioDiario], i) =>
      prisma.employee.create({
        data: {
          companyId: cid,
          nombre,
          apellidoPaterno,
          rfc: `DEM${String(850101 + i * 10101).slice(0, 6)}AA${i}`,
          curp: `DEMO850101H${String(i).padStart(2, "0")}XXX0${i}`,
          nss: `1234567890${i}`,
          fechaIngreso: fecha(y - 2, 3, 1),
          tipoContrato: "01",
          tipoJornada: "01",
          periodicidadPago: "04",
          salarioDiario,
          salarioDiarioIntegrado: r2(salarioDiario * 1.0452),
        },
      }),
    ),
  );

  const [bancoX, bancoY] = await Promise.all([
    prisma.bankAccount.create({
      data: { companyId: cid, banco: "BBVA", nombre: "Operativa", numeroCuenta: "0114455667", clabe: CLABE_X },
    }),
    prisma.bankAccount.create({
      data: { companyId: cid, banco: "Santander", nombre: "Nómina", numeroCuenta: "6559988776", clabe: CLABE_Y },
    }),
  ]);

  // ── Un mes de operación ────────────────────────────────────────────────────
  let folio = 1000;
  async function mesDeVida(per: { y: number; m: number }, opts: { cerrado: boolean }) {
    const uuidBase = `demo-${per.y}${String(per.m).padStart(2, "0")}`;
    // INGRESOS: 9 facturas, mezcla PUE/PPD.
    for (let i = 0; i < 9; i++) {
      const cliente = de(clientes);
      const subtotal = entre(18000, 120000);
      const iva = r2(subtotal * 0.16);
      const total = r2(subtotal + iva);
      const ppd = i % 3 === 0;
      const dia = 2 + i * 3;
      const inv = await prisma.invoice.create({
        data: {
          companyId: cid, customerId: cliente.id,
          tipo: "INGRESO", status: "STAMPED", tipoSat: "I",
          uuid: `${uuidBase}-ing-${i}`, serie: "A", folio: String(folio++),
          fecha: fecha(per.y, per.m, dia),
          formaPago: ppd ? "99" : "03", metodoPago: ppd ? "PPD" : "PUE", usoCfdi: "G03",
          subtotal, total, totalImpuestos: iva,
          rawXml: rawXmlStub(DEMO_RFC, cliente.rfc),
          items: {
            create: {
              cantidad: 1, claveProdServ: "43211500", claveUnidad: "H87",
              descripcion: "Mercancía general", valorUnitario: subtotal, importe: subtotal,
            },
          },
          taxes: { create: { tipo: "IVA", factor: "TASA", tasa: 0.16, base: subtotal, importe: iva } },
        },
      });
      // Cobro conciliado (en meses cerrados: todos; en curso: sólo los primeros 4).
      if (opts.cerrado || i < 4) {
        await prisma.bankTransaction.create({
          data: {
            companyId: cid, bankAccountId: bancoX.id,
            fecha: fecha(per.y, per.m, Math.min(dia + 4, 28)),
            descripcion: `SPEI RECIBIDO ${cliente.razonSocial.slice(0, 18)} REF ${folio}`,
            tipo: "CREDITO", monto: total, status: "MATCHED", invoiceId: inv.id,
            contraparteNombre: cliente.razonSocial, contraparteRfc: cliente.rfc,
            contraparteClabe: `0721800${String(10000000000 + Math.floor(rnd() * 8_999_999_999))}`,
          },
        });
      }
    }
    // EGRESOS: 8 gastos variados (renta con retenciones no — simple 16%).
    const conceptos = [
      "Renta de oficina", "Combustible flotilla", "Servicios de telecomunicaciones",
      "Honorarios contables", "Energía eléctrica", "Papelería y consumibles",
      "Mantenimiento de equipo", "Publicidad digital",
    ];
    for (let i = 0; i < 8; i++) {
      const [provRazon, provRfc] = PROVEEDORES[i % PROVEEDORES.length];
      const subtotal = entre(3000, 42000);
      const iva = r2(subtotal * 0.16);
      const total = r2(subtotal + iva);
      const dia = 3 + i * 3;
      const inv = await prisma.invoice.create({
        data: {
          companyId: cid,
          tipo: "EGRESO", status: "STAMPED", tipoSat: "I",
          uuid: `${uuidBase}-egr-${i}`,
          fecha: fecha(per.y, per.m, dia),
          formaPago: "03", metodoPago: "PUE", usoCfdi: "G03",
          subtotal, total, totalImpuestos: iva,
          rawXml: rawXmlStub(provRfc, DEMO_RFC),
          taxes: { create: { tipo: "IVA", factor: "TASA", tasa: 0.16, base: subtotal, importe: iva } },
        },
      });
      if (opts.cerrado || i < 4) {
        await prisma.bankTransaction.create({
          data: {
            companyId: cid, bankAccountId: bancoX.id,
            fecha: fecha(per.y, per.m, Math.min(dia + 2, 28)),
            descripcion: `SPEI ENVIADO ${provRazon.slice(0, 18)} ${conceptos[i]}`,
            tipo: "DEBITO", monto: -total, status: "MATCHED", invoiceId: inv.id,
            contraparteNombre: provRazon, contraparteRfc: provRfc,
            contraparteClabe: `0141800${String(10000000000 + Math.floor(rnd() * 8_999_999_999))}`,
          },
        });
      }
    }
    // Traspaso X→Y para la nómina (par espejo — el motor lo cruza sin duplicar).
    const traspaso = r2(entre(80000, 120000));
    await prisma.bankTransaction.createMany({
      data: [
        {
          companyId: cid, bankAccountId: bancoX.id, fecha: fecha(per.y, per.m, 14),
          descripcion: "TRASPASO A CTA NOMINA", tipo: "DEBITO", monto: -traspaso,
          status: "IGNORED", notes: "INTERNAL_TRANSFER", contraparteClabe: CLABE_Y,
        },
        {
          companyId: cid, bankAccountId: bancoY.id, fecha: fecha(per.y, per.m, 14),
          descripcion: "DEPOSITO DESDE OPERATIVA", tipo: "CREDITO", monto: traspaso,
          status: "IGNORED", notes: "INTERNAL_TRANSFER", contraparteClabe: CLABE_X,
        },
      ],
    });
    // Comisión bancaria.
    await prisma.bankTransaction.create({
      data: {
        companyId: cid, bankAccountId: bancoX.id, fecha: fecha(per.y, per.m, 28),
        descripcion: "COMISION MEMBRESIA PLUS", tipo: "DEBITO", monto: -entre(350, 600),
        status: "IGNORED", notes: "PENDING_MONTHLY_CFDI",
      },
    });

    // Nómina: dos quincenas. Cerrado → STAMPED; en curso → 1a STAMPED, 2a CALCULATED.
    for (const q of [1, 2] as const) {
      const esActualSinTimbrar = !opts.cerrado && q === 2;
      const fin = q === 1 ? 15 : new Date(Date.UTC(per.y, per.m, 0)).getUTCDate();
      const ini = q === 1 ? 1 : 16;
      if (!opts.cerrado && q === 2 && hoy.getUTCDate() < 26) {
        // La 2a quincena del mes en curso sólo existe cerca del corte…
        if (hoy.getUTCDate() < 13) continue;
      }
      let totalNeto = 0;
      const items = empleados.map((e) => {
        const sueldo = r2(Number(e.salarioDiario) * 15);
        const isr = r2(sueldo * 0.11);
        const imss = r2(sueldo * 0.027);
        const neto = r2(sueldo - isr - imss);
        totalNeto = r2(totalNeto + neto);
        return {
          employeeId: e.id, sueldoBase: sueldo, isrRetenido: isr, imssObrero: imss,
          totalPercepciones: sueldo, totalDeducciones: r2(isr + imss), netoAPagar: neto,
        };
      });
      await prisma.payrollRun.create({
        data: {
          companyId: cid,
          periodo: `${per.y}-${String(per.m).padStart(2, "0")}-${String(ini).padStart(2, "0")}/${per.y}-${String(per.m).padStart(2, "0")}-${String(fin).padStart(2, "0")}`,
          tipo: "ORDINARIA",
          status: esActualSinTimbrar ? "CALCULATED" : "STAMPED",
          fechaPago: fecha(per.y, per.m, fin),
          totalPercepciones: r2(items.reduce((t, i) => t + i.totalPercepciones, 0)),
          totalDeducciones: r2(items.reduce((t, i) => t + i.totalDeducciones, 0)),
          totalNeto,
          items: { create: items },
        },
      });
    }
  }

  console.log("· Sembrando tres meses de operación…");
  await mesDeVida(M3, { cerrado: true });
  await mesDeVida(M2, { cerrado: true });
  await mesDeVida(M1, { cerrado: true });
  await mesDeVida({ y, m }, { cerrado: false });

  // Declaraciones: M3/M2 presentadas; M1 CALCULADA lista para presentar.
  const perStr = (p: { y: number; m: number }) => `${p.y}-${String(p.m).padStart(2, "0")}`;
  await prisma.taxDeclaration.createMany({
    data: [
      { companyId: cid, tipo: "IVA_MENSUAL", periodo: perStr(M3), status: "FILED", ivaPagar: entre(35000, 60000), isrPagar: entre(18000, 30000), updatedAt: new Date() },
      { companyId: cid, tipo: "IVA_MENSUAL", periodo: perStr(M2), status: "FILED", ivaPagar: entre(35000, 60000), isrPagar: entre(18000, 30000), updatedAt: new Date() },
      { companyId: cid, tipo: "IVA_MENSUAL", periodo: perStr(M1), status: "DRAFT", ivaPagar: entre(40000, 65000), isrPagar: entre(20000, 32000), updatedAt: new Date() },
    ],
  });
  // Enteramiento de M3 conciliado en M2 (el motor lo postea contra la subcuenta).
  const declM3 = await prisma.taxDeclaration.findFirst({ where: { companyId: cid, periodo: perStr(M3) } });
  await prisma.bankTransaction.create({
    data: {
      companyId: cid, bankAccountId: bancoX.id, fecha: fecha(M2.y, M2.m, 17),
      descripcion: "SAT PAGO LINEA CAPTURA", tipo: "DEBITO",
      monto: -r2(Number(declM3!.ivaPagar) + Number(declM3!.isrPagar)),
      status: "MATCHED", taxDeclarationId: declM3!.id,
    },
  });

  // El mes en curso, a medio vuelo: ~15 movimientos sin clasificar.
  const sueltos = [
    "SPEI RECIBIDO BANORTE REF 88213", "DEPOSITO EFECTIVO SUC 4411", "SPEI ENVIADO TELETRANSFER",
    "CARGO DOMICILIADO SEGURO AUTO", "SPEI RECIBIDO STP REF 11209", "RETIRO CAJERO 0442",
    "SPEI ENVIADO REF FACT 7781", "DEPOSITO CHEQUE 000412", "CARGO ANUALIDAD TARJETA",
    "SPEI RECIBIDO ALTIPLANO REF 5567", "PAGO TPV COMISION", "SPEI ENVIADO NOMINA EXTERNA",
    "DEVOLUCION COMPRA EN LINEA", "SPEI RECIBIDO REF 90331", "CARGO SERVICIO DIGITAL MX",
  ];
  await prisma.bankTransaction.createMany({
    data: sueltos.map((descripcion, i) => ({
      companyId: cid,
      bankAccountId: i % 3 === 0 ? bancoY.id : bancoX.id,
      fecha: fecha(y, m, Math.min(2 + i * 2, hoy.getUTCDate())),
      descripcion,
      tipo: descripcion.includes("RECIBIDO") || descripcion.includes("DEPOSITO") || descripcion.includes("DEVOLUCION") ? "CREDITO" as const : "DEBITO" as const,
      monto: (descripcion.includes("RECIBIDO") || descripcion.includes("DEPOSITO") || descripcion.includes("DEVOLUCION") ? 1 : -1) * entre(800, 46000),
      status: "UNMATCHED" as const,
    })),
  });

  // Hallazgos del auditor para el rail del Copiloto.
  await prisma.fiscalHallazgo.createMany({
    data: [
      {
        companyId: cid, checkClave: "efos.presunto", severidad: "warn",
        mensaje: "Un proveedor con operaciones este año aparece en la lista 69-B (presunto): TELECOM EMPRESARIAL MX.",
        sugerencia: "Revisa las operaciones con este proveedor y documenta materialidad antes de deducir.",
        fundamentoLey: "CFF", fundamentoArticulo: "69-B", dedupeKey: `demo-${cid}-efos`,
      },
      {
        companyId: cid, checkClave: "cfdi.rep_faltante", severidad: "warn",
        mensaje: "Cobraste $58,420.00 de una factura PPD y no has emitido el complemento de pago.",
        sugerencia: "Emite el REP antes del día 5 del mes siguiente al cobro (RMF 2.7.1.32).",
        fundamentoLey: "RMF", fundamentoArticulo: "2.7.1.32", dedupeKey: `demo-${cid}-rep`,
      },
      {
        companyId: cid, checkClave: "cfdi.duplicado", severidad: "warn",
        mensaje: "2 CFDIs de egreso casi idénticos de PAPELERA CENTRAL por $4,872.00 el mismo día — posible duplicado.",
        sugerencia: "Verifica con el proveedor si son dos comprobantes legítimos o uno duplicado.",
        fundamentoLey: "LISR", fundamentoArticulo: "27", dedupeKey: `demo-${cid}-dup`,
      },
      {
        companyId: cid, checkClave: "isn.estimado", severidad: "info",
        mensaje: "ISN estimado del mes: $14,880.00 (3.0% sobre nómina de Puebla).",
        sugerencia: "Verifica la tasa vigente del estado antes de declarar.",
        fundamentoLey: "Ley de Ingresos Puebla", fundamentoArticulo: "10", dedupeKey: `demo-${cid}-isn`,
      },
    ],
  });

  // Postear los meses cerrados CON EL MOTOR REAL (subcuentas, traspasos, IVA al flujo).
  console.log("· Posteando meses cerrados con el motor real…");
  await postMonth({ companyId: cid, year: M3.y, month: M3.m });
  await postMonth({ companyId: cid, year: M2.y, month: M2.m });
  await postMonth({ companyId: cid, year: M1.y, month: M1.m });

  const resumen = await Promise.all([
    prisma.invoice.count({ where: { companyId: cid } }),
    prisma.bankTransaction.count({ where: { companyId: cid } }),
    prisma.bankTransaction.count({ where: { companyId: cid, status: "UNMATCHED" } }),
    prisma.accountingEntry.count({ where: { companyId: cid } }),
    prisma.payrollRun.count({ where: { companyId: cid, status: "CALCULATED" } }),
    prisma.chartAccount.count({ where: { companyId: cid, subcuenta: { startsWith: "102.01." } } }),
  ]);
  console.log(`
✔ Empresa demo lista: ${DEMO_RAZON} (${DEMO_RFC})
  · ${resumen[0]} CFDIs · ${resumen[1]} movimientos bancarios (${resumen[2]} sin clasificar para la mesa)
  · ${resumen[3]} asientos posteados con el motor real · ${resumen[5]} subcuentas de banco
  · ${resumen[4]} corrida(s) sin timbrar (la cola dirá «Timbrar»)
  · Declaración de ${perStr(M1)} CALCULADA — la cola dirá «Presentar»
  · 4 hallazgos del auditor en el rail del Copiloto
  Entra como ${email} y selecciona la empresa.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
