import { NextResponse } from "next/server";
import JSZip from "jszip";
import { AuthzError, requireMembership } from "@/lib/authz";
import { evaluarReadinessCE } from "@/lib/contabilidad/ce-readiness";
import { generateAuxiliarCtasXml, generateAuxiliarFoliosXml } from "@/lib/contabilidad/coe-auxiliares";
import { generatePolizasXml } from "@/lib/contabilidad/coe-polizas";
import { generateBalanzaXml, generateCatalogoXml } from "@/lib/contabilidad/coe-xml";
import { auxiliarCuenta, balanceGeneralDesdeBalanza, libroDiario, type EntryForLibro } from "@/lib/contabilidad/libro";
import {
  CARPETA,
  campoFolio,
  nombreArchivoSat,
  nombreZip,
  renderManifiesto,
  type ArchivoPaquete,
  type TipoSolicitudPaquete,
} from "@/lib/contabilidad/paquete";
import { balanza, balanzaPreview, estadoResultados, estadoResultadosPreview } from "@/lib/contabilidad/posting";
import {
  clavePeriodo,
  hojaBalanceGeneral,
  hojaBalanza,
  hojaEstadoResultados,
  hojaLibroDiario,
} from "@/lib/contabilidad/reportes-xlsx";
import { toXlsx } from "@/lib/export/xlsx";
import { archivoDiot2025 } from "@/lib/fiscal/diot";
import { cargarProveedoresDiot } from "@/lib/fiscal/diot-datos";
import { prisma } from "@/lib/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/contabilidad/paquete?companyId=&year=&month=
//        [&tipoSolicitud=AF|FC|DE|CO&folio=...]
//
// La ENTREGA del mes en un solo zip: los XML del Anexo 24, los estados
// financieros en Excel y la DIOT. Antes había que bajar cada pieza de su propia
// pantalla y armar la carpeta a mano, cliente por cliente y mes por mes.
//
// Sin `tipoSolicitud` arma la entrega mensual (catálogo + balanza). Con él
// añade pólizas y sus dos auxiliares, que sólo aplican ante un requerimiento
// —auditoría, devolución, compensación— y por eso exigen el folio del acto.
//
// No bloquea cuando la contabilidad no está lista: genera igual y lo DECLARA en
// el manifiesto. Quien arma el paquete suele necesitar verlo justamente cuando
// falta algo.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TIPOS: TipoSolicitudPaquete[] = ["AF", "FC", "DE", "CO"];

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const companyId = url.searchParams.get("companyId");
    const year = parseInt(url.searchParams.get("year") ?? "", 10);
    const month = parseInt(url.searchParams.get("month") ?? "", 10);
    if (!companyId || !Number.isFinite(year) || !Number.isFinite(month)) {
      return NextResponse.json({ error: "companyId, year y month requeridos" }, { status: 400 });
    }

    const tipoParam = url.searchParams.get("tipoSolicitud");
    const tipoSolicitud = TIPOS.includes(tipoParam as TipoSolicitudPaquete)
      ? (tipoParam as TipoSolicitudPaquete)
      : null;
    const folio = url.searchParams.get("folio");
    // El XML de pólizas lleva NumOrden/NumTramite como atributo obligatorio:
    // sin folio saldría inválido, así que es mejor rechazar que entregar basura.
    if (tipoSolicitud && !folio) {
      return NextResponse.json(
        { error: "Con tipoSolicitud hay que enviar el folio del requerimiento (NumOrden o NumTramite)." },
        { status: 400 }
      );
    }

    await requireMembership(companyId, undefined, req);

    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { rfc: true, razonSocial: true },
    });
    if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

    const period = await prisma.accountingPeriod.findUnique({
      where: { companyId_year_month: { companyId, year, month } },
      select: { status: true },
    });
    const posteado = period?.status === "POSTED" || period?.status === "CLOSED";

    const zip = new JSZip();
    const archivos: ArchivoPaquete[] = [];
    const omitidos: string[] = [];
    const agregar = (ruta: string, contenido: string | Uint8Array, descripcion: string) => {
      zip.file(ruta, contenido);
      archivos.push({ ruta, descripcion });
    };

    // ── 1. XML del Anexo 24 ───────────────────────────────────────────────
    // Cada generador puede fallar por su cuenta (catálogo sin sembrar, mes sin
    // asientos). Un tropiezo NO debe tumbar el paquete entero: se declara en el
    // manifiesto y el resto sigue.
    const intentar = async (etiqueta: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        omitidos.push(`${etiqueta}: ${e instanceof Error ? e.message : "error al generar"}`);
      }
    };

    await intentar("Catálogo de cuentas (XML)", async () => {
      const xml = await generateCatalogoXml({ companyId, year, month });
      agregar(
        `${CARPETA.xml}/${nombreArchivoSat(company.rfc, year, month, "CT")}`,
        xml,
        "Catálogo de cuentas con código agrupador (Anexo 24)."
      );
    });

    await intentar("Balanza de comprobación (XML)", async () => {
      const { xml, tipoEnvio } = await generateBalanzaXml({ companyId, year, month });
      agregar(
        `${CARPETA.xml}/${nombreArchivoSat(company.rfc, year, month, "B", tipoEnvio)}`,
        xml,
        `Balanza de comprobación (envío ${tipoEnvio === "N" ? "normal" : "complementario"}).`
      );
    });

    if (tipoSolicitud && folio) {
      const ident = campoFolio(tipoSolicitud) === "numOrden"
        ? { numOrden: folio }
        : { numTramite: folio };
      const opts = { companyId, year, month, tipoSolicitud, ...ident };

      await intentar("Pólizas del periodo (XML)", async () => {
        agregar(
          `${CARPETA.xml}/${nombreArchivoSat(company.rfc, year, month, "PL")}`,
          await generatePolizasXml(opts),
          `Pólizas del periodo — requerimiento ${tipoSolicitud} ${folio}.`
        );
      });
      await intentar("Auxiliar de cuentas (XML)", async () => {
        agregar(
          `${CARPETA.xml}/${nombreArchivoSat(company.rfc, year, month, "XC")}`,
          await generateAuxiliarCtasXml(opts),
          `Auxiliar de cuentas — requerimiento ${tipoSolicitud} ${folio}.`
        );
      });
      await intentar("Auxiliar de folios (XML)", async () => {
        agregar(
          `${CARPETA.xml}/${nombreArchivoSat(company.rfc, year, month, "XF")}`,
          await generateAuxiliarFoliosXml(opts),
          `Auxiliar de folios — requerimiento ${tipoSolicitud} ${folio}.`
        );
      });
    } else {
      omitidos.push(
        "Pólizas y auxiliares (XML): sólo se entregan ante requerimiento del SAT. Vuelve a generar el paquete indicando el tipo y el folio del acto."
      );
    }

    // ── 2. Estados financieros, en UN libro ───────────────────────────────
    await intentar("Estados financieros (Excel)", async () => {
      const filas = posteado
        ? await balanza(companyId, year, month)
        : await balanzaPreview(companyId, year, month);
      const er = posteado
        ? await estadoResultados(companyId, year, month)
        : await estadoResultadosPreview(companyId, year, month);

      const entries = await prisma.accountingEntry.findMany({
        where: { companyId, year, month },
        select: {
          id: true, fecha: true, descripcion: true, monto: true, tipo: true,
          referencia: true, referenciaTipo: true, fuente: true,
          chartAccount: { select: { cuentaSAT: true, subcuenta: true, nombre: true } },
        },
        orderBy: { fecha: "asc" },
      });
      const forLibro: EntryForLibro[] = entries.map((e) => ({
        id: e.id,
        fecha: e.fecha.toISOString().slice(0, 10),
        concepto: e.descripcion,
        tipo: e.tipo,
        monto: e.monto,
        referencia: e.referencia,
        referenciaTipo: e.referenciaTipo,
        fuente: e.fuente,
        numCta: e.chartAccount.subcuenta ?? e.chartAccount.cuentaSAT,
        desCta: e.chartAccount.nombre,
      }));

      const libro = toXlsx([
        hojaBalanza(filas),
        hojaEstadoResultados(er),
        hojaBalanceGeneral(balanceGeneralDesdeBalanza(filas)),
        hojaLibroDiario(libroDiario(forLibro)),
      ]);
      agregar(
        `${CARPETA.estados}/Estados financieros ${clavePeriodo(year, month)}.xlsx`,
        new Uint8Array(libro),
        `Balanza, estado de resultados, balance general y libro diario${posteado ? "" : " (PRELIMINARES)"}.`
      );
    });

    // ── 3. DIOT ───────────────────────────────────────────────────────────
    await intentar("DIOT (.txt)", async () => {
      const proveedores = await cargarProveedoresDiot(companyId, year, month);
      if (proveedores.length === 0) {
        omitidos.push("DIOT: no hubo operaciones con terceros pagadas en el mes.");
        return;
      }
      agregar(
        `${CARPETA.declaraciones}/DIOT_${year}${String(month).padStart(2, "0")}.txt`,
        archivoDiot2025(proveedores),
        `DIOT ${proveedores.length} proveedor(es), base de flujo (Art. 1-B LIVA).`
      );
    });

    // ── 4. Manifiesto ─────────────────────────────────────────────────────
    let readiness: "lista" | "con_huecos" | "incompleta" = "incompleta";
    try {
      readiness = (await evaluarReadinessCE(companyId, year, month)).status;
    } catch {
      omitidos.push("Semáforo de contabilidad electrónica: no se pudo evaluar.");
    }

    zip.file(
      "LEEME.txt",
      renderManifiesto({
        rfc: company.rfc,
        razonSocial: company.razonSocial,
        year,
        month,
        posteado,
        readiness,
        archivos,
        omitidos,
        generadoEn: new Date().toISOString().slice(0, 16).replace("T", " "),
      })
    );

    const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${nombreZip(company.rfc, year, month)}"`,
      },
    });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    const msg = e instanceof Error ? e.message : "Error generando el paquete";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
