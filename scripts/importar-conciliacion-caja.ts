// ─────────────────────────────────────────────────────────────────────────────
// Importa la conciliación del mes desde el Excel que lleva caja.
//
// Haltus (CPM2307076Z9) tenía 58 depósitos de terminal sin conciliar por
// $1.68M — un mes. El adquirente deposita un lote y el estado de cuenta sólo
// dice «HOSP HALTUS 09992889D»: sin el desglose, nadie puede decir qué
// facturas cubre. Caja SÍ lo sabe y lo lleva en un Excel; esto lo lee.
//
// Cubre el libro COMPLETO, no sólo la terminal: SPEI, pago de tercero,
// depósito en efectivo y los movimientos que no son cobro. El archivo es la
// conciliación de caja y es la autoridad.
//
// CÓMO ESTÁ ARMADO (verificado contra los 147 movimientos de agosto 2026):
// cada renglón con COMENTARIO abre un movimiento; los renglones siguientes SIN
// comentario son su desglose. La columna «DESGLOSE DE VENTAS TPV» trae la
// porción de cada factura — y cuando viene vacía con una sola factura, el
// movimiento ES esa factura completa. Cuando el renglón no nombra ninguna
// factura, la columna CLIENTE dice qué ES: TRASPASO, BANCARIZACION, DEV DE
// FAC… Eso no es un cobro y no se concilia contra nada.
//
// TODO ENTRA POR ConciliacionDetalle, NUNCA por BankTransaction.invoiceId.
// Con `invoiceId` el motor asigna el movimiento COMPLETO a esa factura
// (`repartoMovimiento`), y entonces un pago parcial es inexpresable. Con
// detalles, cada porción lleva su monto: la factura queda parcialmente pagada
// y lo que sobra del movimiento cae a ANTICIPOS DE CLIENTES (206.01), que es
// una obligación que envejece a la vista y no un saldo diluido.
//
// Uso:
//   npx tsx scripts/importar-conciliacion-caja.ts <archivo.xlsx> [--rfc RFC] [--aplicar] [--corregir] [--clasificar]
//
// `--clasificar` marca IGNORED los movimientos que el archivo dice que NO son
// cobro. Sin eso quedan en UNMATCHED, indistinguibles de un pendiente real:
// agosto cerraba con 23 «sin conciliar» de los que 16 eran traspasos entre
// cuentas propias. La naturaleza del Excel se TRADUCE a una etiqueta que el
// cierre acepte (ver naturaleza-caja.ts); lo que no se pueda traducir se queda
// pendiente a propósito.
//
// `--corregir` DESHACE lo conciliado que contradice al archivo. La
// auto-conciliación empareja por MONTO Y FECHA cuando el movimiento no trae
// contraparte —un depósito de terminal nunca la trae— y con eso un depósito de
// $10,000 se casó con una factura de $10,000 de meses antes, y un traspaso
// entre cuentas propias se casó con la factura de un paciente. Como esas
// facturas quedaban «pagadas», bloqueaban a los depósitos que sí les
// correspondían. El Excel de caja sabe qué paciente pagó; el matcher adivinaba.
// ─────────────────────────────────────────────────────────────────────────────

import * as XLSX from "xlsx";
import { prisma } from "../src/lib/prisma";
import { checkInvoiceMatchGuard, mergePagosConciliados } from "../src/lib/conciliacion";
import { NOTA_DE_CAJA, etiquetaDeNaturaleza } from "../src/lib/bancos/naturaleza-caja";

const PAT_AFILIACION = /\b(\d{7,})([CD])\b/;
/** Ventana para casar el depósito del Excel con el movimiento del banco. */
const DIAS_VENTANA = 3;

type Linea = { uuid: string; folio: string; monto: number };
/** Sólo letras y dígitos: el archivo y el banco separan distinto. */
const norm = (x: string) => x.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * ¿Este movimiento bancario ES el renglón del archivo?
 *
 * Importe y fecha NO bastan. Los cinco errores de $3,770 de agosto salieron
 * justo de eso: un precio de lista se repite muchas veces al mes y el importe
 * solo empareja el depósito con la factura equivocada. Por eso hay que exigir
 * además la identidad que trae el comentario:
 *   · TPV      → la afiliación, que es única por terminal;
 *   · lo demás → el comentario del estado de cuenta, que es de donde caja
 *                copió su renglón, comparado sin separadores.
 */
/**
 * De los movimientos que empatan, cuál es EL del renglón.
 *
 * Importa: el hospital cobra el mismo precio de lista muchas veces —agosto
 * trae cinco depósitos de $3,770 en la misma afiliación en ocho días— y entre
 * ellos importe, fecha y afiliación son idénticos. Tomar el primero empareja
 * el renglón con el vecino y luego «corrige» dos conciliaciones que estaban
 * bien. Cuando alguno ya trae justo la factura que el archivo nombra, ése es.
 */
function elegir<T extends { aplicadas: Set<string> }>(cand: T[], d: Deposito): T | undefined {
  if (cand.length <= 1) return cand[0];
  const enArchivo = d.lineas.map((l) => l.uuid.toUpperCase());
  return cand.find((m) => enArchivo.some((u) => m.aplicadas.has(u))) ?? cand[0];
}

function empata(mov: { descripcion: string; monto: unknown; fecha: Date; aplicadas: Set<string> }, d: Deposito): boolean {
  if (Math.abs(Number(mov.monto) - d.importe) >= 0.01) return false;
  if (Math.abs(mov.fecha.getTime() - d.fecha.getTime()) > DIAS_VENTANA * 86400000) return false;
  if (d.afiliacion) return mov.descripcion.includes(d.afiliacion);
  // Los dos textos son el MISMO concepto con distinto detalle. El banco nos
  // manda la forma corta con su clave de operación al frente —«T20 SPEI
  // RECIBIDO BANCOPPEL»— y caja copió la larga, que sigue con la referencia y
  // el ordenante: «SPEI RECIBIDOBANCOPPEL/0125098711 137 1008260paulina…».
  // Quitada la clave, uno es prefijo del otro.
  // La clave es SIEMPRE letra + dos dígitos (T20, N06, Y45, P14…). Tentaba
  // aceptar «2 a 4 alfanuméricos», pero eso se come la primera PALABRA cuando
  // es corta: «PAGO CUENTA DE TERCERO» quedaba en «CUENTA DE TERCERO» y ya no
  // empataba con su propio renglón. Y no todas las descripciones traen clave.
  const a = norm(mov.descripcion.replace(/^[A-Z]\d{2}\s+/i, ""));
  const b = norm(d.coment);
  // Renglón sin comentario: no hay con qué identificarlo. Emparejar por importe
  // y fecha es justo lo que mete la factura equivocada, así que sólo se acepta
  // el movimiento que YA trae alguna de sus facturas — sirve para confirmar lo
  // que hay, nunca para conciliar algo nuevo.
  if (!b) return d.lineas.some((l) => mov.aplicadas.has(l.uuid.toUpperCase()));
  if (a.length < 8) return false;
  return b.startsWith(a) || a.startsWith(b);
}

type Deposito = {
  /** Afiliación de terminal cuando el comentario la trae; null si no es TPV. */
  afiliacion: string | null;
  /** El comentario del estado de cuenta, que es la mejor señal de identidad. */
  coment: string;
  /** Lo que el archivo dice que ES, cuando no le pone factura: TRASPASO,
   *  BANCARIZACION, DEV DE FAC… Esos NO se concilian contra una factura. */
  naturaleza: string | null;
  fecha: Date;
  importe: number;
  lineas: Linea[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Serial de Excel (base 1900) → Date UTC. */
function fechaDeSerial(serial: number): Date {
  return new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
}

function leerDepositos(ruta: string): Deposito[] {
  const libro = XLSX.readFile(ruta);
  const hoja = libro.Sheets[libro.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json<unknown[]>(hoja, { header: 1, blankrows: true, raw: true });

  const col = { fecha: 1, coment: 2, importe: 3, folio: 5, uuid: 6, cliente: 9, tpv: 12 };
  const txt = (f: unknown[], i: number) => String(f?.[i] ?? "").trim();
  const num = (f: unknown[], i: number) => {
    const v = f?.[i];
    return typeof v === "number" ? v : Number.isFinite(Number(v)) && String(v).trim() !== "" ? Number(v) : null;
  };

  const deps: Deposito[] = [];
  let abierto: { coment: string; fecha: number | null; importe: number | null; naturaleza: string | null; lineas: Array<{ uuid: string; folio: string; tpv: number | null }> } | null = null;

  const cerrar = () => {
    if (!abierto) return;
    if (abierto.importe == null || abierto.fecha == null) return;
    const conTpv = abierto.lineas.filter((l) => l.tpv != null && l.uuid);
    // Una sola factura y sin desglose: el depósito es esa factura completa.
    const crudas =
      conTpv.length === 0 && abierto.lineas.length === 1 && abierto.lineas[0].uuid
        ? [{ uuid: abierto.lineas[0].uuid, folio: abierto.lineas[0].folio, monto: abierto.importe }]
        : conTpv.map((l) => ({ uuid: l.uuid, folio: l.folio, monto: r2(l.tpv!) }));

    // El Excel puede repetir una factura dentro del mismo depósito (dos
    // vouchers de la misma cuenta). ConciliacionDetalle es único por
    // (movimiento, factura), así que se suman.
    const porUuid = new Map<string, Linea>();
    for (const l of crudas) {
      const k = l.uuid.toUpperCase();
      const prev = porUuid.get(k);
      if (prev) prev.monto = r2(prev.monto + l.monto);
      else porUuid.set(k, { uuid: k, folio: l.folio, monto: l.monto });
    }
    const m = PAT_AFILIACION.exec(abierto.coment);
    deps.push({
      afiliacion: m ? m[1] + m[2] : null,
      coment: abierto.coment,
      naturaleza: porUuid.size === 0 ? abierto.naturaleza : null,
      fecha: fechaDeSerial(abierto.fecha),
      importe: r2(abierto.importe),
      lineas: [...porUuid.values()],
    });
  };

  for (const f of filas) {
    const coment = txt(f, col.coment);
    // Lo que abre un movimiento es la FECHA, no el comentario. Caja lo deja en
    // blanco de vez en cuando, y tomar ese renglón como desglose del anterior
    // le cuelga su factura a otro movimiento: así el traspaso de $200,000 del
    // 18-ago arrastró la factura 1428 —de $3,770— y el guard reportaba
    // $203,770 aplicados a una factura de $3,770.
    //
    // El IMPORTE no sirve para esto: los renglones de desglose de un depósito
    // en efectivo también lo traen (es la parte que toca a cada factura). Lo
    // que ninguno trae es fecha.
    const fecha = num(f, col.fecha);
    if (coment || fecha != null) {
      cerrar();
      abierto = { coment, fecha, importe: num(f, col.importe), naturaleza: null, lineas: [] };
    }
    if (!abierto) continue;
    // Un encabezado de sección (el libro trae uno por banco) cierra el grupo.
    if (coment.toUpperCase() === "COMENTARIO") { abierto = null; continue; }
    const uuid = txt(f, col.uuid);
    if (uuid) abierto.lineas.push({ uuid, folio: txt(f, col.folio), tpv: num(f, col.tpv) });
    else if (!abierto.naturaleza) abierto.naturaleza = txt(f, col.cliente) || null;
  }
  cerrar();
  return deps;
}

async function main() {
  const ruta = process.argv[2];
  if (!ruta) throw new Error("uso: importar-conciliacion-caja.ts <archivo.xlsx> [--rfc RFC] [--aplicar]");
  const aplicar = process.argv.includes("--aplicar");
  const corregir = process.argv.includes("--corregir");
  const clasificar = process.argv.includes("--clasificar");
  const i = process.argv.indexOf("--rfc");
  const rfc = i > 0 ? process.argv[i + 1] : "CPM2307076Z9";

  const empresa = await prisma.company.findFirst({ where: { rfc }, select: { id: true, razonSocial: true } });
  if (!empresa) throw new Error(`empresa ${rfc} no encontrada`);

  const deps = leerDepositos(ruta);
  console.log(`${empresa.razonSocial} (${rfc})`);
  console.log(`${deps.length} movimientos en el archivo · ${money(deps.reduce((s, d) => s + d.importe, 0))}`);
  console.log(aplicar ? "\nMODO: APLICAR\n" : "\nMODO: dry-run (no escribe nada)\n");

  const movsRaw = await prisma.bankTransaction.findMany({
    where: { companyId: empresa.id, monto: { gt: 0 } },
    select: {
      id: true, fecha: true, descripcion: true, monto: true, status: true, invoiceId: true, notes: true,
      invoice: { select: { uuid: true } },
      conciliacionDetalles: { select: { id: true, invoice: { select: { uuid: true } } } },
    },
  });
  // Qué facturas trae YA aplicadas cada movimiento, venga de un 1:1 o de
  // detalles. El pase previo compara ese conjunto contra el del archivo.
  const movs = movsRaw.map((m) => ({
    ...m,
    aplicadas: new Set<string>([
      ...(m.invoice?.uuid ? [m.invoice.uuid.toUpperCase()] : []),
      ...m.conciliacionDetalles.map((c) => c.invoice?.uuid?.toUpperCase()).filter((u): u is string => !!u),
    ]),
  }));

  // Un movimiento se usa UNA vez. El adquirente deposita el mismo importe dos
  // veces el mismo día en la misma afiliación más seguido de lo que parece
  // —visto en Haltus: 09992889C 14-ago $10,000.00 ×2— y sin consumirlos, los
  // dos renglones del Excel eligen el mismo movimiento y el segundo choca con
  // el único (movimiento, factura).
  const usados = new Set<string>();
  let listos = 0, yaEstaban = 0, sinMovimiento = 0, rechazados = 0, escritos = 0;
  let naturaleza = 0, malMarcados = 0, clasificados = 0;
  let montoListo = 0, montoSobrante = 0;

  // ── Pase previo: deshacer lo que contradice al archivo ───────────────────
  // Va ANTES de escribir nada: liberar la factura de un depósito es lo que
  // deja pasar a OTRO depósito que también la toca. Con el orden al revés, el
  // segundo se rechazaría por una sobre-aplicación que estaba por corregirse.
  //
  // Y compara el CONJUNTO de facturas, no sólo si hay alguna. Que el
  // movimiento ya esté conciliado no quiere decir que lo esté bien: agosto
  // traía cinco depósitos de $3,770 —un precio de lista— casados por importe
  // con la factura equivocada, y contarlos como «ya conciliados» era
  // justamente lo que los dejaba pasar.
  if (corregir) {
    const tomados = new Set<string>();
    let deshechos = 0;
    for (const d of deps) {
      if (d.lineas.length === 0) continue; // los de naturaleza los ve el pase principal
      const mov = elegir(movs.filter((m) => !tomados.has(m.id) && empata(m, d)), d);
      if (!mov) continue;
      tomados.add(mov.id);
      if (mov.aplicadas.size === 0) continue;

      const enArchivo = new Set(d.lineas.map((l) => l.uuid.toUpperCase()));
      const igual = mov.aplicadas.size === enArchivo.size && [...enArchivo].every((u) => mov.aplicadas.has(u));
      if (igual) continue;

      const etiqueta = `${(d.afiliacion ?? d.coment.slice(0, 22)).padEnd(22)} ${d.fecha.toISOString().slice(0, 10)} ${money(d.importe).padStart(12)}`;
      console.log(`  ↺ ${etiqueta}  deshago ${mov.aplicadas.size} → ${d.lineas.map((l) => l.folio).join(" + ")}`);
      if (aplicar) {
        await prisma.$transaction([
          prisma.conciliacionDetalle.deleteMany({ where: { bankTransactionId: mov.id } }),
          prisma.bankTransaction.update({ where: { id: mov.id }, data: { invoiceId: null, status: "UNMATCHED" } }),
        ]);
      }
      mov.invoiceId = null;
      mov.status = "UNMATCHED";
      mov.conciliacionDetalles = [];
      mov.aplicadas.clear();
      deshechos++;
    }
    console.log(`\n  conciliaciones que contradicen el archivo: ${deshechos}${aplicar ? " (deshechas)" : " (dry-run)"}\n`);
  }

  for (const d of deps) {
    const etiqueta = `${(d.afiliacion ?? d.coment.slice(0, 22)).padEnd(22)} ${d.fecha.toISOString().slice(0, 10)} ${money(d.importe).padStart(12)}`;

    const mov = elegir(movs.filter((m) => !usados.has(m.id) && empata(m, d)), d);
    if (!mov) { sinMovimiento++; console.log(`  ✗ ${etiqueta}  sin movimiento bancario disponible que empate`); continue; }
    usados.add(mov.id);

    // Renglón sin factura: el archivo dice qué ES (TRASPASO, BANCARIZACION,
    // DEV DE FAC…). No es un cobro, así que no se concilia contra nada — y si
    // la app le puso factura, está mal y se deshace. Así salió el traspaso de
    // $30,000 del 31-ago que la app había casado con la PG-979.
    if (d.lineas.length === 0) {
      naturaleza++;
      const facturado = mov.invoiceId || mov.conciliacionDetalles.length > 0;
      if (facturado) {
        malMarcados++;
        console.log(`  ↺ ${etiqueta}  «${d.naturaleza ?? "sin factura"}» — deshago la conciliación`);
        if (aplicar) {
          await prisma.$transaction([
            prisma.conciliacionDetalle.deleteMany({ where: { bankTransactionId: mov.id } }),
            prisma.bankTransaction.update({ where: { id: mov.id }, data: { invoiceId: null, status: "UNMATCHED" } }),
          ]);
        }
        mov.status = "UNMATCHED";
      }

      // Dejarlo en UNMATCHED es dejarlo como pendiente, y no lo es: el archivo
      // ya dijo qué es. Agosto cerraba con 23 «sin conciliar» de los que 16 son
      // traspasos entre cuentas propias — ruido que alguien descarta a mano
      // cada mes. IGNORED es la marca de «visto y no es cobro».
      //
      // `notes` es el campo de ETIQUETA, no una bitácora: el cierre sólo acepta
      // las de IGNORED_TAGS_VALIDOS y bloquea el mes ante cualquier otra cosa.
      // Lo que caja escribe hay que TRADUCIRLO, y lo que no se pueda traducir
      // se queda pendiente para una persona.
      if (clasificar) {
        const tag = etiquetaDeNaturaleza(d.naturaleza);
        const puestoPorEsteScript = (mov.notes ?? "").startsWith(NOTA_DE_CAJA);

        if (tag && mov.status !== "IGNORED") {
          clasificados++;
          console.log(`  ⊘ ${etiqueta}  «${d.naturaleza}» → ${tag}`);
          if (aplicar) {
            await prisma.bankTransaction.update({ where: { id: mov.id }, data: { status: "IGNORED", notes: tag } });
          }
        } else if (tag && mov.notes !== tag && puestoPorEsteScript) {
          // Reparación de la primera versión, que guardaba el texto del Excel.
          clasificados++;
          console.log(`  ⊘ ${etiqueta}  etiqueta corregida → ${tag}`);
          if (aplicar) await prisma.bankTransaction.update({ where: { id: mov.id }, data: { notes: tag } });
        } else if (!tag && puestoPorEsteScript) {
          // Se marcó algo que no se sabe traducir: vuelve a pendiente.
          console.log(`  ↺ ${etiqueta}  «${d.naturaleza}» sin etiqueta que le corresponda — vuelve a pendiente`);
          if (aplicar) {
            await prisma.bankTransaction.update({ where: { id: mov.id }, data: { status: "UNMATCHED", notes: null } });
          }
        } else if (!tag && d.naturaleza && mov.status === "UNMATCHED") {
          console.log(`  ? ${etiqueta}  «${d.naturaleza}» — el archivo dice que no es cobro, pero no sé cómo etiquetarlo`);
        }
      }
      continue;
    }

    // Idempotente: lo ya conciliado (por este script o a mano) no se re-escribe.
    if (mov.status === "MATCHED" || mov.conciliacionDetalles.length > 0) { yaEstaban++; continue; }

    // Las facturas, y el guard de cada una con lo que YA tiene aplicado.
    const facturas = await prisma.invoice.findMany({
      where: { companyId: empresa.id, uuid: { in: d.lineas.map((l) => l.uuid) } },
      select: {
        id: true, uuid: true, tipo: true, status: true, metodoPago: true, total: true,
        bankTransactions: { where: { status: "MATCHED" }, select: { id: true, fecha: true, monto: true } },
        conciliacionDetalles: { select: { bankTransactionId: true, montoAsignado: true, bankTransaction: { select: { fecha: true, monto: true } } } },
      },
    });
    const porUuid = new Map(facturas.filter((f) => f.uuid).map((f) => [f.uuid!.toUpperCase(), f]));

    const problemas: string[] = [];
    const asignaciones: Array<{ invoiceId: string; montoAsignado: number }> = [];
    for (const l of d.lineas) {
      const f = porUuid.get(l.uuid.toUpperCase());
      if (!f) { problemas.push(`UUID sin factura: ${l.uuid.slice(0, 8)}`); continue; }
      if (f.status !== "STAMPED") { problemas.push(`${l.folio} no está timbrada (${f.status})`); continue; }
      if (f.tipo !== "INGRESO") { problemas.push(`${l.folio} no es de ingreso (${f.tipo})`); continue; }

      const previos = mergePagosConciliados(
        f.bankTransactions.map((t) => ({ ...t, monto: Number(t.monto) })),
        f.conciliacionDetalles.map((x) => ({
          bankTransactionId: x.bankTransactionId,
          montoAsignado: Number(x.montoAsignado),
          bankTransaction: { fecha: x.bankTransaction.fecha, monto: Number(x.bankTransaction.monto) },
        })),
      );
      const g = checkInvoiceMatchGuard(
        { metodoPago: f.metodoPago, total: Number(f.total) },
        previos,
        { id: mov.id, monto: Number(mov.monto), montoAsignado: l.monto },
      );
      if (!g.ok) { problemas.push(`${l.folio}: ${g.error}`); continue; }
      asignaciones.push({ invoiceId: f.id, montoAsignado: l.monto });
    }

    if (problemas.length > 0 || asignaciones.length === 0) {
      rechazados++;
      console.log(`  ✗ ${etiqueta}`);
      for (const p of problemas.slice(0, 3)) console.log(`      ${p.slice(0, 120)}`);
      continue;
    }

    const asignado = r2(asignaciones.reduce((s, a) => s + a.montoAsignado, 0));
    const sobrante = r2(d.importe - asignado);
    listos++;
    montoListo += asignado;
    montoSobrante += sobrante;
    const nota = sobrante > 0.005 ? `  · sobrante ${money(sobrante)} → anticipo` : "";
    console.log(`  ✓ ${etiqueta}  ${asignaciones.length} factura(s)${nota}`);

    if (aplicar) {
      // Todo-o-nada, igual que la ruta de conciliación múltiple del hub.
      await prisma.$transaction([
        prisma.conciliacionDetalle.createMany({
          data: asignaciones.map((a) => ({ bankTransactionId: mov.id, invoiceId: a.invoiceId, montoAsignado: a.montoAsignado })),
        }),
        prisma.bankTransaction.update({ where: { id: mov.id }, data: { status: "MATCHED", invoiceId: null } }),
      ]);
      escritos++;
    }
  }

  console.log(`\n── resumen ─────────────────────────────`);
  console.log(`  listos para conciliar : ${String(listos).padStart(3)}   ${money(montoListo).padStart(14)}`);
  console.log(`  sobrante a anticipos  :       ${money(montoSobrante).padStart(14)}`);
  console.log(`  ya conciliados        : ${String(yaEstaban).padStart(3)}`);
  console.log(`  sin movimiento        : ${String(sinMovimiento).padStart(3)}`);
  console.log(`  rechazados por guard  : ${String(rechazados).padStart(3)}`);
  console.log(`  sin factura (traspaso…): ${String(naturaleza).padStart(3)}${malMarcados ? `   de los cuales ${malMarcados} estaban mal conciliados` : ""}`);
  if (clasificar) console.log(`  marcados «no es cobro» : ${String(clasificados).padStart(3)}`);
  if (aplicar) console.log(`  ESCRITOS              : ${String(escritos).padStart(3)}`);
  else console.log(`\n  (dry-run — con --aplicar se escriben)`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
