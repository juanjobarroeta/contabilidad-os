import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertPuedeEscribir } from "@/lib/subscription";
import { AuthzError, getEffectiveCompanyMembership, requireUser } from "@/lib/authz";
import { provisionFacturapiOrg } from "@/lib/facturapi";
import { provisionCompany } from "@/lib/fiscal/cumplimiento/syntage/provision";
import { kickCron } from "@/lib/cron-scheduler";
import { seedChartOfAccounts } from "@/lib/contabilidad/seed-catalog";
import { seedCompanyObligaciones } from "@/lib/obligaciones-seed";
import { encryptNullable } from "@/lib/crypto";
import { parseCertExpiry } from "@/lib/fiel";
import { sincronizarCantidadDespacho } from "@/lib/billing/sync-cantidad-despacho";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json([], { status: 401 });

  // Operador de plataforma: ve TODAS las empresas activas de todos los
  // despachos (supervisión cross-despacho). Bypasea la unión de membresías.
  const operador = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { esOperador: true },
  });
  if (operador?.esOperador) {
    const all = await prisma.company.findMany({
      where: { isActive: true },
      select: {
        id: true,
        rfc: true,
        razonSocial: true,
        regimenFiscal: true,
        codigoPostal: true,
        isActive: true,
        // El operador ve empresas de varios despachos: incluimos el nombre del
        // despacho para que el selector las agrupe en vez de mezclarlas.
        despachoId: true,
        despacho: { select: { name: true } },
      },
      orderBy: [{ despacho: { name: "asc" } }, { razonSocial: "asc" }],
    });
    return NextResponse.json(
      all.map(({ despacho, ...c }) => ({ ...c, despachoNombre: despacho?.name ?? null }))
    );
  }

  // Two access paths, union'd and deduped:
  //   1. Direct CompanyMember rows (explicit invitations)
  //   2. Companies owned by a Despacho the user is a member of
  const [direct, despachoMember] = await Promise.all([
    prisma.companyMember.findMany({
      where: { userId: session.user.id },
      include: {
        company: {
          select: {
            id: true,
            rfc: true,
            razonSocial: true,
            regimenFiscal: true,
            codigoPostal: true,
            isActive: true,
          },
        },
      },
    }),
    prisma.despachoMember.findFirst({
      where: { userId: session.user.id },
      select: { id: true, despachoId: true },
    }),
  ]);

  let despachoCompanies: typeof direct[number]["company"][] = [];
  if (despachoMember) {
    // Check per-company scoping: if member has scope rows, filter to those
    const scopeRows = await prisma.despachoMemberCompany.findMany({
      where: { despachoMemberId: despachoMember.id },
      select: { companyId: true },
    });
    const scopedIds = scopeRows.map(s => s.companyId);

    despachoCompanies = await prisma.company.findMany({
      where: {
        despachoId: despachoMember.despachoId,
        ...(scopedIds.length > 0 ? { id: { in: scopedIds } } : {}),
      },
      select: {
        id: true,
        rfc: true,
        razonSocial: true,
        regimenFiscal: true,
        codigoPostal: true,
        isActive: true,
      },
    });
  }

  // Union by id
  const byId = new Map<string, typeof direct[number]["company"]>();
  for (const m of direct) {
    if (m.company.isActive) byId.set(m.company.id, m.company);
  }
  for (const c of despachoCompanies) {
    if (c.isActive) byId.set(c.id, c);
  }

  return NextResponse.json(Array.from(byId.values()));
}

export async function POST(req: Request) {
  // Bearer-aware: los satélites (Automotriz, …) crean la empresa desde su
  // wizard de onboarding con el token de /api/auth/token; la web sigue
  // entrando por la cookie de NextAuth (requireUser intenta ambos).
  let session: { user: { id: string } };
  try {
    const user = await requireUser(req);
    session = { user: { id: user.id } };
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  try {
    // Gating detrás de SUBSCRIPTION_ENFORCEMENT_ENABLED (default apagado).
    await assertPuedeEscribir(session.user.id);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const body = await req.json();
  const {
    rfc, razonSocial, regimenFiscal, codigoPostal, domicilioFiscal,
    nombreComercial, email, telefono, actividadEconomica,
    csdCer, csdKey, csdPassword,
    fielCer, fielKey, fielPassword,
    fechaInicioRegimen,
    regimenes,
    satBackfillYears,
    plan,
    csfObligaciones,
    manifiestoAck,
    onboardingPackage,
    grupoId,
    modulos,
  } = body as {
    rfc: string; razonSocial: string; regimenFiscal: string; codigoPostal: string;
    domicilioFiscal?: string; nombreComercial?: string; email?: string;
    telefono?: string; actividadEconomica?: string;
    csdCer?: string; csdKey?: string; csdPassword?: string;
    fielCer?: string; fielKey?: string; fielPassword?: string;
    fechaInicioRegimen?: string | null;
    regimenes?: Array<{ code: string; label?: string | null; since?: string | null }>;
    satBackfillYears?: number;
    plan?: string;
    csfObligaciones?: string[];
    manifiestoAck?: boolean;
    onboardingPackage?: {
      imss?: {
        registroPatronal?: string | null;
        clase?: string | null;
        fraccion?: string | null;
        prima?: number | null;
      } | null;
      acuseAnual?: {
        ejercicio?: number | null;
        coeficienteUtilidad?: number | null;
        utilidadFiscal?: number | null;
        isrCausado?: number | null;
        isrAPagar?: number | null;
        lineaCaptura?: string | null;
        fechaPresentacion?: string | null;
      } | null;
      acusesMensuales?: Array<{
        periodoMes?: number | null;
        periodoAnio?: number | null;
        tipoImpuesto?: "IVA" | "ISR" | "IVA_ISR" | "RETENCIONES" | null;
        tipoPago?: string | null;
        ivaCausado?: number | null;
        ivaAcreditable?: number | null;
        ivaAPagar?: number | null;
        ivaAFavor?: number | null;
        ivaSaldoFavorAplicado?: number | null;
        isrIngresos?: number | null;
        isrRetenciones?: number | null;
        isrPagosAnteriores?: number | null;
        isrAPagar?: number | null;
        coeficienteUtilidadAplicado?: number | null;
        lineaCaptura?: string | null;
        fechaPresentacion?: string | null;
      } | null>;
    };
    grupoId?: string | null;
    modulos?: string[];
  };

  if (!rfc || !razonSocial || !regimenFiscal || !codigoPostal) {
    return NextResponse.json({ error: "Faltan campos requeridos" }, { status: 400 });
  }

  // Módulos verticales que el wizard de un satélite puede auto-habilitar al
  // crear la empresa (p. ej. Automotriz manda ["AUTOMOTRIZ"]). Lista blanca
  // explícita — CONTABILIDAD siempre se habilita de base más abajo.
  const MODULOS_AUTOHABILITABLES = new Set([
    "AUTOMOTRIZ", "CONSTRUCCION", "PADEL", "PURIFICADORA", "RESTAURANTE", "FLOTA",
  ]);
  const modulosExtra = [...new Set(modulos ?? [])].filter((m) =>
    MODULOS_AUTOHABILITABLES.has(m)
  ) as Prisma.CompanyModuleCreateWithoutCompanyInput["modulo"][];

  // ── RFC duplicado (el RFC es único en TODA la plataforma) ──────────────────
  // Antes esto explotaba como P2002 sin manejar → 500 sin cuerpo JSON, y el
  // onboarding moría con "Unexpected end of JSON input" sin decirle al usuario
  // qué pasó (caso real: un cliente reintentó 8 veces contra el mismo RFC ya
  // registrado). Ahora se responde 409 con la salida correcta según el caso.
  const rfcNorm = rfc.toUpperCase().trim();
  const existente = await prisma.company.findUnique({
    where: { rfc: rfcNorm },
    select: { id: true, isActive: true },
  });
  if (existente) {
    const acceso = await getEffectiveCompanyMembership(session.user.id, existente.id);
    return NextResponse.json(
      {
        error: acceso
          ? "Esta empresa ya está registrada y ya tienes acceso a ella. Selecciónala en el selector de empresas (arriba a la izquierda) en lugar de crearla de nuevo."
          : "Este RFC ya está registrado en la plataforma por otra cuenta. Si la empresa es tuya, pide a quien la administra que te invite desde Configuración → Usuarios, o escríbenos para ayudarte a recuperar el acceso.",
        codigo: "RFC_DUPLICADO",
        ...(acceso ? { companyId: existente.id } : {}),
      },
      { status: 409 },
    );
  }

  // Auto-link to the creator's despacho (if they belong to one). Every
  // despacho member automatically gets access to companies the despacho
  // owns, so this is the main path for teams/firms. The creator still gets
  // an explicit CompanyMember(OWNER) row too for unambiguous ownership
  // (e.g. only explicit OWNERs can delete or transfer the company).
  const despachoMembership = await prisma.despachoMember.findFirst({
    where: { userId: session.user.id },
    select: { despachoId: true, despacho: { select: { defaultTier: true, maxEmpresas: true } } },
  });
  // Tier con el que nace la empresa: el defaultTier del despacho si lo fijó una
  // invitación de onboarding (Syntage on/off según las condiciones), o el
  // default del esquema (AUTOMATIZADO) para altas normales.
  const tierDespacho = despachoMembership?.despacho?.defaultTier ?? undefined;

  // Tope de empresas del despacho (condición de la invitación de onboarding):
  // se valida contra las ACTIVAS — una baja libera el lugar. Null = sin límite.
  const maxEmpresas = despachoMembership?.despacho?.maxEmpresas ?? null;
  if (despachoMembership && maxEmpresas != null) {
    const activas = await prisma.company.count({
      where: { despachoId: despachoMembership.despachoId, isActive: true },
    });
    if (activas >= maxEmpresas) {
      return NextResponse.json(
        {
          error: `Tu plan incluye hasta ${maxEmpresas} empresa${maxEmpresas === 1 ? "" : "s"} y ya las tienes dadas de alta. Escríbenos para ampliar tu límite.`,
          codigo: "LIMITE_EMPRESAS",
        },
        { status: 403 },
      );
    }
  }

  // Extract IMSS + anual fields from onboardingPackage so they persist on Company row
  const registroPatronal = onboardingPackage?.imss?.registroPatronal ?? null;
  const coeficienteUtilidad = onboardingPackage?.acuseAnual?.coeficienteUtilidad ?? null;

  // Grupo: solo se acepta si pertenece al MISMO despacho del creador (evita
  // asignar una empresa a un grupo ajeno). Null si no aplica o no coincide.
  let grupoIdValido: string | null = null;
  if (grupoId && despachoMembership?.despachoId) {
    const g = await prisma.grupo.findFirst({
      where: { id: grupoId, despachoId: despachoMembership.despachoId },
      select: { id: true },
    });
    grupoIdValido = g?.id ?? null;
  }

  // fechaInicioRegimen (from the Constancia de Situación Fiscal) becomes the
  // lower bound for the historical SAT backfill — we never ask SAT for CFDIs
  // before this date. Parse defensively: accept a valid ISO date or skip.
  let fechaInicioOperaciones: Date | null = null;
  if (fechaInicioRegimen) {
    const parsed = new Date(fechaInicioRegimen);
    if (!isNaN(parsed.getTime())) fechaInicioOperaciones = parsed;
  }

  // Build the full régimen list. `regimenFiscal` is the chosen primary; the
  // `regimenes` array (from onboarding) holds every régimen on the CSF. Always
  // ensure the primary is present and flagged, de-dupe by code, and fall back
  // to a single-row list for older clients that don't send the array.
  const parseSince = (s?: string | null): Date | null => {
    if (!s) return null;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  };
  const regimenByCode = new Map<
    string,
    { code: string; label: string; since: Date | null; isPrimary: boolean }
  >();
  for (const r of regimenes ?? []) {
    if (!r?.code || regimenByCode.has(r.code)) continue;
    regimenByCode.set(r.code, {
      code: r.code,
      label: r.label || r.code,
      since: parseSince(r.since),
      isPrimary: r.code === regimenFiscal,
    });
  }
  if (!regimenByCode.has(regimenFiscal)) {
    regimenByCode.set(regimenFiscal, {
      code: regimenFiscal,
      label: regimenFiscal,
      since: fechaInicioOperaciones,
      isPrimary: true,
    });
  }
  const regimenCreate = [...regimenByCode.values()];

  // Encrypt credential material before persisting. In production
  // encryptSecret/encryptNullable throw if CREDENTIALS_ENCRYPTION_KEY is
  // missing/invalid (never store plaintext) — surface that as a clean 500
  // instead of an unhandled crash.
  let credencialesCifradas: {
    csdCer?: string; csdKey?: string; csdPassword?: string;
    fielCer?: string; fielKey?: string; fielPassword?: string;
  };
  try {
    credencialesCifradas = {
      csdCer: encryptNullable(csdCer),
      csdKey: encryptNullable(csdKey),
      csdPassword: encryptNullable(csdPassword),
      fielCer: encryptNullable(fielCer),
      fielKey: encryptNullable(fielKey),
      fielPassword: encryptNullable(fielPassword),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error de cifrado";
    console.error("[companies/POST] cifrado de credenciales falló:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const creadorId = session.user.id;
  let company;
  try {
    company = await crearCompany();
  } catch (e) {
    // Carrera contra el pre-check (dos creaciones simultáneas del mismo RFC).
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json(
        {
          error:
            "Este RFC ya está registrado en la plataforma. Si la empresa es tuya, pide a quien la administra que te invite, o escríbenos para ayudarte.",
          codigo: "RFC_DUPLICADO",
        },
        { status: 409 },
      );
    }
    throw e;
  }

  async function crearCompany() {
    return prisma.company.create({
    data: {
      rfc: rfcNorm,
      razonSocial,
      regimenFiscal,
      codigoPostal,
      domicilioFiscal,
      nombreComercial,
      email,
      telefono,
      actividadEconomica,
      ...credencialesCifradas,
      fielVigencia: fielCer ? parseCertExpiry(fielCer) : undefined, // e.firma expiry

      fechaInicioOperaciones: fechaInicioOperaciones ?? undefined,
      satBackfillYears: [0, 1, 5].includes(satBackfillYears as number)
        ? (satBackfillYears as number)
        : undefined,
      plan: ["BASICO", "PROFESIONAL", "DESPACHO"].includes(plan ?? "")
        ? plan
        : undefined,
      facturapiManifiestoAckAt: manifiestoAck ? new Date() : undefined,
      registroPatronal: registroPatronal ?? undefined,
      coeficienteUtilidad: coeficienteUtilidad ?? undefined,
      despachoId: despachoMembership?.despachoId ?? null,
      ...(tierDespacho ? { tier: tierDespacho } : {}),
      grupoId: grupoIdValido,
      members: {
        create: {
          userId: creadorId,
          role: "OWNER",
        },
      },
      // Every new company gets the base accounting module enabled.
      // Add-on modules (CONSTRUCCION, FLOTA, …) are enabled separately
      // by an admin, by the Stripe webhook on add-on purchase, or — vía
      // `modulos` — por el wizard de onboarding de un satélite (lista blanca).
      modules: {
        create: [
          { modulo: "CONTABILIDAD" as const },
          ...modulosExtra
            .filter((m) => m !== "CONTABILIDAD")
            .map((modulo) => ({ modulo })),
        ],
      },
      regimenes: {
        create: regimenCreate,
      },
    },
    });
  }

  // Si el creador paga plan DESPACHO (per-unit por empresa, mínimo 10) en
  // Stripe, sube la cantidad de su suscripción. Fire-and-forget: nunca lanza
  // ni bloquea el alta (loguea y registra bitácora "billing.quantity-sync").
  void sincronizarCantidadDespacho(session.user.id, "empresa.alta");

  // Auto-seed recurring fiscal obligations now (rather than lazily on first
  // Cumplimiento page load). Uses the CSF's explicit obligaciones when present
  // (authoritative), else derives from the full set of régimen codes.
  try {
    await seedCompanyObligaciones(
      company.id,
      regimenCreate.map((r) => r.code),
      { csfObligaciones: Array.isArray(csfObligaciones) ? csfObligaciones : undefined }
    );
  } catch (e) {
    // Non-fatal: obligations also seed lazily on the Cumplimiento page.
    console.error("[companies] obligation seed failed", e);
  }

  // Persist historical monthly declarations parsed from acuses
  // These are flagged isHistorical=true so they're treated as baseline data
  // by carryover logic but hidden from "periodos pendientes" lists.
  if (onboardingPackage?.acusesMensuales?.length) {
    for (const m of onboardingPackage.acusesMensuales) {
      if (!m || !m.periodoMes || !m.periodoAnio) continue;
      const periodo = `${m.periodoAnio}-${String(m.periodoMes).padStart(2, "0")}`;

      // One acuse can cover both IVA and ISR, or just one. We create a row
      // per impuesto type so the tax module can read them like organic rows.
      const tipos: ("IVA_MENSUAL" | "ISR_PROVISIONAL")[] = [];
      if (m.tipoImpuesto === "IVA" || m.tipoImpuesto === "IVA_ISR") tipos.push("IVA_MENSUAL");
      if (m.tipoImpuesto === "ISR" || m.tipoImpuesto === "IVA_ISR") tipos.push("ISR_PROVISIONAL");
      if (tipos.length === 0) continue;

      for (const tipo of tipos) {
        try {
          await prisma.taxDeclaration.create({
            data: {
              companyId: company.id,
              tipo,
              periodo,
              status: "FILED",
              isHistorical: true,
              ivaTrasladadoCobrado: tipo === "IVA_MENSUAL" ? m.ivaCausado ?? null : null,
              ivaAcreditableGastado: tipo === "IVA_MENSUAL" ? m.ivaAcreditable ?? null : null,
              ivaPagar: tipo === "IVA_MENSUAL" ? m.ivaAPagar ?? null : null,
              ivaSaldoFavor: tipo === "IVA_MENSUAL" ? m.ivaAFavor ?? null : null,
              isrIngresos: tipo === "ISR_PROVISIONAL" ? m.isrIngresos ?? null : null,
              isrPagar: tipo === "ISR_PROVISIONAL" ? m.isrAPagar ?? null : null,
              isrCoeficienteUtilidad:
                tipo === "ISR_PROVISIONAL" ? m.coeficienteUtilidadAplicado ?? null : null,
              lineaCaptura: m.lineaCaptura ?? null,
              fechaPresentacion: m.fechaPresentacion ? new Date(m.fechaPresentacion) : null,
            },
          });
        } catch (e) {
          console.error("[companies] Historical declaration create failed:", e);
        }
      }
    }
  }

  // Persist annual declaration if present
  if (onboardingPackage?.acuseAnual?.ejercicio) {
    try {
      const a = onboardingPackage.acuseAnual;
      await prisma.taxDeclaration.create({
        data: {
          companyId: company.id,
          tipo: "DECLARACION_ANUAL",
          periodo: String(a.ejercicio),
          status: "FILED",
          isHistorical: true,
          isrIngresos: a.utilidadFiscal ?? null,
          isrPagar: a.isrAPagar ?? null,
          isrCoeficienteUtilidad: a.coeficienteUtilidad ?? null,
          lineaCaptura: a.lineaCaptura ?? null,
          fechaPresentacion: a.fechaPresentacion ? new Date(a.fechaPresentacion) : null,
        },
      });
    } catch (e) {
      console.error("[companies] Historical anual create failed:", e);
    }
  }

  // Seed the SAT chart of accounts. Best-effort — don't fail the request.
  try {
    await seedChartOfAccounts(company.id);
  } catch (e) {
    console.error("[companies] seedChartOfAccounts failed:", e);
  }

  // Auto-provision Facturapi org. Best-effort: company creation must not fail
  // if Facturapi is down. The result is returned to the client so the UI can
  // surface a warning ("CSD missing", "Facturapi down", etc.).
  const facturapi = await provisionFacturapiOrg(company.id);

  // If e.firma was provided at creation, kick a Syntage provision immediately
  // so the new client doesn't wait for the next cron. SIN force: respeta tier
  // (ASISTENTE no extrae) y nivel de pago; para un plan con Syntage el
  // resultado es idéntico (empresa nueva → salen los 4 + CE). El force queda
  // para el aprovisionamiento manual del operador (cron ?companyId=).
  // Best-effort: only triggers extractions (sync persists results later).
  let syntage = null;
  if (fielCer && fielKey && fielPassword) {
    try {
      syntage = await provisionCompany(company.id, undefined, { force: false });
    } catch (e) {
      syntage = { error: e instanceof Error ? e.message : String(e) };
    }
    // El backfill de CFDIs arranca YA para la empresa nueva (primer envío de
    // solicitudes al SAT); los ticks del scheduler importan conforme el SAT
    // libere los paquetes. El cliente ve su historial entrar sin esperar.
    kickCron("sat-backfill");
  }

  return NextResponse.json({ ...company, facturapi, syntage }, { status: 201 });
}
