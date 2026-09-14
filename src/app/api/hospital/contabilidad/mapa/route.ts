/**
 * GET /api/hospital/contabilidad/mapa?companyId=
 *   → { activa, claves: [{ clave, descripcion, tipo, cuentaSAT, subcuenta, origen: DEFAULT|CONFIG|OVERRIDE, cuenta: { id, codigo, nombre } | null }] }
 * PUT /api/hospital/contabilidad/mapa { companyId, cuentas: { <clave>: { cuentaSAT, subcuenta? } | null }, activa?, aplicarSugerencias? }
 *   · `cuentaSAT`: código agrupador del SAT con el que se asienta la clave (se crea del catálogo si falta);
 *   · `subcuenta`: una cuenta CONCRETA del catálogo de la empresa (código propio o subcuenta) → además
 *     PostingCuentaOverride `hospital:<clave>`; · null borra la decisión (vuelve al default);
 *   · `activa` enciende/apaga el asentado (HospConfig.contabilidadActiva);
 *   · `aplicarSugerencias` guarda de una las propuestas EXACTAS del catálogo propio
 *     (ver src/lib/hospital/sugerir-mapa.ts) y devuelve `aplicadas: ClaveMotor[]`.
 *
 * Ver src/lib/hospital/contabilidad.ts.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";
import {
  CLAVES_MOTOR,
  MAPA_DEFAULT,
  codigoMotorDe,
  definicionCatalogo,
  esClaveMotor,
  leerConfigCuentas,
  localizarCuenta,
  mapaCuentas,
  type ConfigCuentas,
} from "@/lib/hospital/contabilidad";

export const GET = withHospital(async (req: Request) => {
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);
  return NextResponse.json(await mapaCuentas(prisma, companyId));
});

const codigo = z.string().trim().min(1).max(40);
const putSchema = z.object({
  companyId: z.string().min(1),
  cuentas: z.record(z.string(), z.object({ cuentaSAT: codigo.optional(), subcuenta: codigo.nullable().optional() }).nullable()).default({}),
  activa: z.boolean().optional(),
  /**
   * Toma las propuestas EXACTAS del mapa y las guarda como decisión, todas de
   * una. Las PARECIDAS no: ésas las mira una persona. Lo que venga explícito en
   * `cuentas` manda sobre la propuesta.
   */
  aplicarSugerencias: z.boolean().optional(),
});

export const PUT = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { companyId, cuentas, activa, aplicarSugerencias } = parsed.data;

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  // Las propuestas seguras, como si las hubiera tecleado quien decide: entran
  // por la misma puerta (y la misma validación) que una elección a mano.
  const aplicadas: string[] = [];
  if (aplicarSugerencias) {
    const mapa = await mapaCuentas(prisma, companyId);
    for (const r of mapa.claves) {
      if (r.sugerencia?.confianza !== "EXACTA" || cuentas[r.clave] !== undefined) continue;
      cuentas[r.clave] = { cuentaSAT: r.cuentaSAT, subcuenta: r.sugerencia.cuenta.codigo };
      aplicadas.push(r.clave);
    }
  }

  const config = await prisma.hospConfig.findUnique({ where: { companyId }, select: { cuentasContables: true } });
  const actual: ConfigCuentas = leerConfigCuentas(config?.cuentasContables);
  const overridesPoner: Array<{ codigoMotor: string; chartAccountId: string }> = [];
  const overridesBorrar: string[] = [];

  for (const [clave, valor] of Object.entries(cuentas)) {
    if (!esClaveMotor(clave)) return error(`Clave desconocida: ${clave} (válidas: ${CLAVES_MOTOR.join(", ")})`);
    if (valor === null) {
      delete actual[clave];
      overridesBorrar.push(codigoMotorDe(clave));
      continue;
    }
    const cuentaSAT = valor.cuentaSAT ?? MAPA_DEFAULT[clave].cuentaSAT;
    const subcuenta = valor.subcuenta ?? null;
    if (subcuenta) {
      const cuenta = await localizarCuenta(prisma, companyId, subcuenta);
      if (!cuenta) return error(`${clave}: la cuenta ${subcuenta} no existe en el catálogo de la empresa`);
      overridesPoner.push({ codigoMotor: codigoMotorDe(clave), chartAccountId: cuenta.id });
    } else {
      overridesBorrar.push(codigoMotorDe(clave));
      if (!(await localizarCuenta(prisma, companyId, cuentaSAT)) && !definicionCatalogo(cuentaSAT)) {
        return error(`${clave}: ${cuentaSAT} no es una cuenta del catálogo ni un código agrupador del SAT`);
      }
    }
    actual[clave] = { cuentaSAT, subcuenta };
  }

  await prisma.$transaction(async (tx) => {
    const cuentasContables = actual as Prisma.InputJsonObject;
    await tx.hospConfig.upsert({
      where: { companyId },
      update: { cuentasContables, ...(activa === undefined ? {} : { contabilidadActiva: activa }) },
      create: { companyId, cuentasContables, contabilidadActiva: activa ?? false },
    });
    if (overridesBorrar.length) {
      await tx.postingCuentaOverride.deleteMany({ where: { companyId, codigoMotor: { in: overridesBorrar } } });
    }
    for (const o of overridesPoner) {
      await tx.postingCuentaOverride.upsert({
        where: { companyId_codigoMotor: { companyId, codigoMotor: o.codigoMotor } },
        update: { chartAccountId: o.chartAccountId },
        create: { companyId, codigoMotor: o.codigoMotor, chartAccountId: o.chartAccountId },
      });
    }
  });

  bitacora(user, req, {
    companyId,
    accion: "hospital.contabilidad.mapa",
    entidad: "HospConfig",
    entidadId: companyId,
    detalle: { cuentas, activa: activa ?? null, aplicadas },
  });
  return NextResponse.json({ ...(await mapaCuentas(prisma, companyId)), aplicadas });
});
