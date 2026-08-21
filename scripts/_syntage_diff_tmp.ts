import { PrismaClient } from "@prisma/client";
import { SyntageClient } from "../src/lib/fiscal/cumplimiento/syntage/client";
import * as fs from "fs";
import * as os from "os";

const C = "cmsjf1wna003kn70fb68bqhm4";
const RFC = "AMA170817NK1";

async function main() {
  const cfg = JSON.parse(fs.readFileSync(`${os.homedir()}/.claude/jobs/b2a65a05/tmp/.syntage`, "utf8"));
  const client = new SyntageClient({ apiKey: cfg.key, baseUrl: cfg.base || undefined } as never);
  const prisma = new PrismaClient();
  try {
    const ent = await client.findEntityByRfc(RFC);
    if (!ent) return console.log("Syntage no tiene entidad para", RFC);
    console.log("entidad Syntage:", ent.id);

    const nuestros = new Set(
      (await prisma.invoice.findMany({ where: { companyId: C, uuid: { not: null } }, select: { uuid: true } }))
        .map((i) => i.uuid!.toUpperCase()),
    );
    console.log("CFDIs en ContabilidadOS:", nuestros.size.toLocaleString("es-MX"));

    let cursor: string | null = null;
    let total = 0, faltan = 0, conXml = 0;
    const muestra: string[] = [];
    const porAnio = new Map<string, { syn: number; falta: number }>();
    for (let pagina = 0; pagina < 1200; pagina++) {
      const r: { facturas: any[]; siguienteCursor: string | null } =
        await client.listEntityInvoices(ent.id, { porPagina: 100, cursor: cursor ?? undefined });
      for (const f of r.facturas) {
        total++;
        const uuid = String(f.uuid ?? "").toUpperCase();
        const anio = String(f.issuedAt ?? "").slice(0, 4) || "?";
        const acc = porAnio.get(anio) ?? { syn: 0, falta: 0 };
        acc.syn++;
        if (f.xml) conXml++;
        if (uuid && !nuestros.has(uuid)) {
          faltan++; acc.falta++;
          if (muestra.length < 8) muestra.push(`${anio} ${f.type ?? "?"} ${f.status ?? "?"} ${uuid} xml:${f.xml ? "sí" : "no"}`);
        }
        porAnio.set(anio, acc);
      }
      if (total % 5000 === 0) console.log(`  … ${total.toLocaleString("es-MX")} revisadas, ${faltan.toLocaleString("es-MX")} sin importar`);
      cursor = r.siguienteCursor;
      if (!cursor) break;
    }
    console.log(`\nSyntage tiene ${total.toLocaleString("es-MX")} CFDIs (${conXml.toLocaleString("es-MX")} con XML)`);
    console.log(`NO importados a ContabilidadOS: ${faltan.toLocaleString("es-MX")}`);
    console.log("\naño   Syntage   faltantes");
    for (const [a, v] of [...porAnio.entries()].sort())
      console.log(`${a}  ${String(v.syn).padStart(8)}  ${String(v.falta).padStart(8)}`);
    if (muestra.length) { console.log("\nmuestra de faltantes:"); for (const m of muestra) console.log("  " + m) }
  } finally { await prisma.$disconnect(); }
}
main();
