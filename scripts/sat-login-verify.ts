/**
 * Ingeniería inversa de la firma del login e.firma del portal SAT. El token del
 * POST es base64( base64("guid|RFC|serial") + "#" + base64(firma) ). Aquí se
 * VERIFICA la firma capturada contra la LLAVE PÚBLICA del cert (no hace falta la
 * privada) para descubrir QUÉ se firma y con qué hash → la receta exacta para
 * reproducir el login en HTTP puro (reemplazar auth.ts).
 *
 * Uso: DATABASE_URL=<url> CREDENTIALS_ENCRYPTION_KEY=<k> [HAR=ruta] \
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/sat-login-verify.ts
 */
import { PrismaClient } from "@prisma/client";
import { decryptSecret } from "../src/lib/crypto";
import * as crypto from "node:crypto";
import * as fs from "node:fs";

const HAR = process.env.HAR ?? "tmp/recon-sat/sat.har";

async function main() {
  const prisma = new PrismaClient();
  const c = await prisma.company.findFirst({ where: { rfc: "AMA170817NK1" }, select: { fielCer: true } });
  await prisma.$disconnect();
  const cerDer = Buffer.from(decryptSecret(c!.fielCer!), "base64");
  const cert = new crypto.X509Certificate(cerDer);
  const pub = cert.publicKey;
  console.log("cert serial:", cert.serialNumber);

  const har = JSON.parse(fs.readFileSync(HAR, "utf8"));
  let token = "";
  for (const e of har.log.entries) {
    if (e.request.url.includes("id=fiel_Aviso") && e.request.method === "POST") {
      for (const p of e.request.postData?.params ?? []) if (p.name === "token") token = p.value;
    }
  }
  const inner = Buffer.from(token, "base64").toString("latin1");
  const [partA, partB] = inner.split("#");
  const challenge = Buffer.from(partA, "base64").toString("utf8");
  // partB es DOBLE base64: decode → texto base64 de 344 chars → decode → firma 256B.
  const partBtexto = Buffer.from(partB, "base64").toString("latin1");
  const sig = Buffer.from(partBtexto, "base64");
  console.log("challenge:", challenge);
  console.log("firma bytes:", sig.length, "(", sig.length * 8, "bit )");

  const candidates: Array<[string, Buffer]> = [
    ["challenge utf8 (guid|RFC|serial)", Buffer.from(challenge, "utf8")],
    ["partA (base64 string)", Buffer.from(partA, "utf8")],
    ["partA+'=='", Buffer.from(partA.endsWith("==") ? partA : partA + "==", "utf8")],
    ["token base64 string", Buffer.from(token, "utf8")],
  ];
  let hit = false;
  for (const algo of ["RSA-SHA1", "RSA-SHA256", "RSA-SHA512", "RSA-MD5"]) {
    for (const [name, data] of candidates) {
      const v = crypto.createVerify(algo);
      v.update(data);
      v.end();
      let ok = false;
      try {
        ok = v.verify(pub, sig);
      } catch {
        /* algo/key mismatch */
      }
      if (ok) {
        console.log(`✅ MATCH  ${algo}  sobre  «${name}»`);
        hit = true;
      }
    }
  }
  if (!hit) console.log("❌ ningún candidato verificó — el contenido firmado es otro (más candidatos).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
