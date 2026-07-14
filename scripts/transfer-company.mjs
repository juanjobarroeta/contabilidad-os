/**
 * Admin: transfiere la PROPIEDAD de una empresa a otra cuenta (por correo),
 * conservando toda su historia (CFDIs, bancos, nómina, declaraciones).
 *
 * Usage:
 *   set -a; . ./.env.local; set +a
 *   node scripts/transfer-company.mjs <rfc> <emailNuevoOwner> [opciones]
 *   node scripts/transfer-company.mjs <rfc> <emailNuevoOwner> --apply
 *
 * Opciones:
 *   --apply                Aplica los cambios (sin esto es dry-run).
 *   --remove-old-members   Quita las membresías directas existentes (el
 *                          traspaso completo: los miembros anteriores pierden
 *                          acceso). Sin esta bandera se conservan.
 *   --despacho <id>        Liga la empresa al despacho indicado.
 *   --sin-despacho         Desliga la empresa de su despacho actual.
 *
 * Caso de uso: un RFC se dio de alta bajo NUESTRA cuenta (pilotos, pruebas) y
 * el dueño real quiere operarla bajo SU cuenta/despacho. Re-crearla perdería
 * la historia — y meses que ya agotaron la cuota vitalicia de Descarga Masiva
 * del SAT (código 5002) NO se pueden volver a descargar. Transferir conserva
 * todo: sólo cambian las membresías y (opcionalmente) el despacho.
 *
 * IMPORTANTE: si la empresa queda ligada a un despacho, TODOS los miembros de
 * ese despacho conservan acceso implícito (así funciona la autorización). Para
 * un traspaso real usa --sin-despacho o --despacho <el del nuevo dueño>.
 *
 * El nuevo dueño debe existir como usuario (que se registre primero). La
 * facturación no se toca: el tier de la empresa queda igual y el webhook de
 * Stripe del nuevo dueño la adoptará cuando compre su plan.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const [rfcArg, emailArg] = args;
  const rfc = (rfcArg ?? "").toUpperCase().trim();
  const email = (emailArg ?? "").toLowerCase().trim();
  const apply = args.includes("--apply");
  const removeOld = args.includes("--remove-old-members");
  const sinDespacho = args.includes("--sin-despacho");
  const despachoIdx = args.indexOf("--despacho");
  const despachoId = despachoIdx >= 0 ? (args[despachoIdx + 1] ?? "").trim() : null;

  if (!rfc || !email || !email.includes("@")) {
    console.error("Usage: node scripts/transfer-company.mjs <rfc> <emailNuevoOwner> [--apply] [--remove-old-members] [--despacho <id> | --sin-despacho]");
    process.exit(1);
  }
  if (sinDespacho && despachoId) {
    console.error("❌ --sin-despacho y --despacho son mutuamente excluyentes.");
    process.exit(1);
  }

  const company = await prisma.company.findUnique({
    where: { rfc },
    select: {
      id: true, rfc: true, razonSocial: true, despachoId: true, tier: true,
      despacho: { select: { name: true } },
      members: { select: { userId: true, role: true, user: { select: { email: true, name: true } } } },
    },
  });
  if (!company) {
    console.error(`❌ No hay empresa con RFC ${rfc}`);
    process.exit(1);
  }

  const nuevoOwner = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true },
  });
  if (!nuevoOwner) {
    console.error(`❌ No hay usuario con correo ${email}. Pídele que se registre primero (crear cuenta, SIN crear empresa) y vuelve a correr el script.`);
    process.exit(1);
  }

  let nuevoDespacho = null;
  if (despachoId) {
    nuevoDespacho = await prisma.despacho.findUnique({
      where: { id: despachoId },
      select: { id: true, name: true },
    });
    if (!nuevoDespacho) {
      console.error(`❌ No hay despacho con id ${despachoId}`);
      process.exit(1);
    }
  }

  console.log(`Empresa:   ${company.razonSocial} (${company.rfc}) · tier ${company.tier}`);
  console.log(`Despacho:  ${company.despacho ? `${company.despacho.name} (${company.despachoId})` : "— sin despacho —"}`);
  console.log(`Miembros actuales:`);
  for (const m of company.members) {
    console.log(`  · ${m.user.email} (${m.user.name ?? "sin nombre"}) — ${m.role}`);
  }
  console.log(`\nNuevo dueño: ${nuevoOwner.email} (${nuevoOwner.name ?? "sin nombre"})\n`);

  const acciones = [];
  const yaEsMiembro = company.members.find((m) => m.userId === nuevoOwner.id);
  acciones.push(
    yaEsMiembro
      ? `Actualizar membresía de ${nuevoOwner.email} a OWNER (era ${yaEsMiembro.role})`
      : `Crear membresía OWNER para ${nuevoOwner.email}`
  );
  if (removeOld) {
    for (const m of company.members) {
      if (m.userId !== nuevoOwner.id) acciones.push(`Quitar membresía de ${m.user.email} (${m.role})`);
    }
  }
  if (sinDespacho && company.despachoId) acciones.push("Desligar del despacho actual");
  if (nuevoDespacho) acciones.push(`Ligar al despacho ${nuevoDespacho.name} (${nuevoDespacho.id})`);
  if (!removeOld && (company.despachoId && !sinDespacho && !nuevoDespacho)) {
    acciones.push(
      "ADVERTENCIA: la empresa sigue ligada a su despacho actual — TODOS los miembros de ese despacho conservan acceso implícito."
    );
  }

  console.log(`${apply ? "Aplicando" : "DRY-RUN — se haría"}:`);
  for (const a of acciones) console.log(`  - ${a}`);

  if (!apply) {
    console.log("\nNada se cambió. Corre con --apply para aplicar.");
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.companyMember.upsert({
      where: { userId_companyId: { userId: nuevoOwner.id, companyId: company.id } },
      update: { role: "OWNER" },
      create: { userId: nuevoOwner.id, companyId: company.id, role: "OWNER" },
    });
    if (removeOld) {
      await tx.companyMember.deleteMany({
        where: { companyId: company.id, userId: { not: nuevoOwner.id } },
      });
    }
    if (sinDespacho || nuevoDespacho) {
      await tx.company.update({
        where: { id: company.id },
        data: { despachoId: nuevoDespacho ? nuevoDespacho.id : null },
      });
    }
  });

  console.log("\nListo. La historia (CFDIs, bancos, nómina, declaraciones) queda intacta.");
  console.log("Recuerda: el tier no cambió; si el nuevo dueño contrata plan en Stripe, el webhook lo aplicará a sus empresas.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
