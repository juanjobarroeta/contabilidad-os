import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { camposContraparte, parseSpei, tieneContraparte } from "@/lib/bancos/spei-descripcion";
import { vincularComisionesDeCuenta } from "@/lib/bancos/comisiones-repo";
import { repararMojibake, tieneMojibake } from "@/lib/bancos/decodificar";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/bancos-contraparte-backfill   [?limit=N][&companyId=]
//
// Desglosa la contraparte de los movimientos bancarios YA IMPORTADOS: nombre,
// RFC, CLABE, banco, concepto, clave de rastreo y línea de captura. Todo eso ya
// venía escrito y etiquetado dentro de `descripcion` — el banco lo manda así —
// pero se guardaba como una sola cadena.
//
// RETROACTIVO Y GRATIS: la descripción está intacta en la base, así que este
// barrido no toca al banco, no descarga nada y no cuesta un peso. Es puramente
// local: leer una columna de texto y escribir siete.
//
// LO QUE DESBLOQUEA: con el RFC de la contraparte como CAMPO, la conciliación
// automática deja de adivinar por monto y pasa a identificar por parte (ver
// scoreCandidate en bancos/auto-conciliar.ts).
//
// Gap-driven e idempotente: sólo toca filas con `contraparteAt` nulo, y las
// SELLA aunque no se extraiga nada. Esa marca no es opcional — sin ella, los
// depósitos en efectivo y las comisiones (que legítimamente no traen
// contraparte) reentrarían en cada corrida y el barrido giraría sobre las
// mismas filas para siempre. Es el mismo bucle que costó 243 re-parseos de
// acuses anuales, y aquí sería gratis pero igual de inútil.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los otros crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PAGE = 1_000;
const TIME_BUDGET_MS = 240_000;
// Trabajo puramente local (un regex sobre texto ya guardado + un UPDATE): el
// tope real lo pone el presupuesto de tiempo, no un límite conservador.
const DEFAULT_LIMIT = 50_000;
const MAX_LIMIT = 200_000;
// El vínculo de comisiones mira más atrás que la ventana normal: aquí se está
// arreglando historia, no procesando el mes en curso.
const VENTANA_BACKFILL = new Date("2020-01-01T00:00:00Z");

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  // Acotable a UNA empresa: el orquestador de carga inicial le da prioridad a
  // la recién onboardeada en vez de esperar al barrido general.
  const onlyCompanyId = url.searchParams.get("companyId");
  const limitParam = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(limitParam, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const startedAt = Date.now();

  let procesadas = 0;
  let conContraparte = 0;
  let conRfc = 0;
  let conClaveRastreo = 0;
  let conLineaCaptura = 0;
  let reparadas = 0;
  let sinReparar = 0;
  // Cursor por id: las filas resueltas salen del filtro (quedan selladas), así
  // que paginar por id evita re-leerlas.
  let cursorId: string | null = null;

  while (procesadas < limit && Date.now() - startedAt < TIME_BUDGET_MS) {
    const where: Prisma.BankTransactionWhereInput = {
      contraparteAt: null,
      ...(onlyCompanyId ? { companyId: onlyCompanyId } : {}),
      ...(cursorId ? { id: { gt: cursorId } } : {}),
    };
    const lote = await prisma.bankTransaction.findMany({
      where,
      select: { id: true, descripcion: true },
      orderBy: { id: "asc" },
      take: Math.min(PAGE, limit - procesadas),
    });
    if (lote.length === 0) break;
    cursorId = lote[lote.length - 1].id;

    for (const tx of lote) {
      procesadas++;
      // El backfill no tiene la columna críptica del CSV original (Banorte),
      // sólo la descripción guardada. Los bancos que etiquetan la clave de
      // rastreo dentro del texto (Bajío) sí la rinden aquí; los que la mandan
      // en columna aparte la ganarán al reimportar.
      // Repara el mojibake que NOSOTROS causamos al decodificar mal el CSV
      // (el front leía UTF-8 a fuerza sobre archivos Windows-1252). No es
      // editar lo que escribió el banco: el byte original decía "ó" y esto lo
      // devuelve a "ó". Sólo palabras con una sola lectura posible.
      const reparada = repararMojibake(tx.descripcion);
      if (reparada !== tx.descripcion) reparadas++;

      const campos = camposContraparte(parseSpei(reparada));
      const sello = new Date();

      await prisma.bankTransaction
        .update({
          where: { id: tx.id },
          data: {
            ...campos,
            ...(reparada !== tx.descripcion ? { descripcion: reparada } : {}),
            contraparteAt: sello,
          },
        })
        .catch(() => {}); // best-effort: una fila no debe tumbar el barrido

      if (tieneMojibake(reparada)) sinReparar++;

      if (tieneContraparte(campos)) conContraparte++;
      if (campos.contraparteRfc) conRfc++;
      if (campos.claveRastreo) conClaveRastreo++;
      if (campos.lineaCaptura) conLineaCaptura++;
    }
  }

  // Con la clave de rastreo ya extraída, cuelga cada comisión de la
  // transferencia que la generó. Va DESPUÉS del desglose (necesita la clave) y
  // sólo sobre las cuentas que este barrido tocó, para no repasar la cartera
  // entera en cada corrida.
  let comisionesVinculadas = 0;
  if (procesadas > 0) {
    const cuentas = await prisma.bankAccount.findMany({
      where: onlyCompanyId ? { companyId: onlyCompanyId } : {},
      select: { id: true },
      take: 500,
    });
    for (const c of cuentas) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) break;
      try {
        const r = await vincularComisionesDeCuenta(c.id, { desde: VENTANA_BACKFILL });
        comisionesVinculadas += r.vinculadas;
      } catch {
        // best-effort: una cuenta no debe tumbar el barrido
      }
    }
  }

  const restantes = await prisma.bankTransaction.count({
    where: {
      contraparteAt: null,
      ...(onlyCompanyId ? { companyId: onlyCompanyId } : {}),
    },
  });

  return NextResponse.json({
    ok: true,
    procesadas,
    conContraparte,
    // Los que ya traen RFC son los que NO habrá que consultarle a Banxico:
    // este número es directamente el ahorro del CEP.
    conRfc,
    // Los que traen clave de rastreo pero no RFC son los candidatos a CEP.
    conClaveRastreo,
    conLineaCaptura,
    // Descripciones cuyos acentos se restauraron, y las que siguen con daño
    // fuera del vocabulario conocido (ahí sí hay que reimportar el mes).
    reparadas,
    sinReparar,
    comisionesVinculadas,
    restantes,
    ms: Date.now() - startedAt,
  });
}

export async function POST(req: Request) {
  return withCronLock("cron:bancos-contraparte-backfill", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:bancos-contraparte-backfill", () => handle(req));
}
