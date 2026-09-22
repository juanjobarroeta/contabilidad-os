// ─────────────────────────────────────────────────────────────────────────────
// La e.firma que SatGo necesita para los endpoints *fiel (csffiel / ocfiel /
// decfiel): el .cer y el .key en DER tal cual y la contraseña en claro, que es
// exactamente lo que ya guardamos cifrado por empresa. Mismo patrón que
// sat-portal/buzon-playwright.getFielBytes, sin arrastrar Playwright.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";

export interface FielSatGo {
  rfc: string;
  cer: Buffer;
  key: Buffer;
  pass: string;
}

export type FielResolver = (companyId: string) => Promise<FielSatGo>;

export class FielNoDisponibleError extends Error {
  constructor(readonly rfc: string, motivo: string) {
    super(`e.firma de ${rfc}: ${motivo}`);
    this.name = "FielNoDisponibleError";
  }
}

/** Carga y descifra la e.firma guardada de la empresa. */
export async function fielDeEmpresa(companyId: string): Promise<FielSatGo> {
  const c = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, fielCer: true, fielKey: true, fielPassword: true },
  });
  if (!c?.rfc) throw new FielNoDisponibleError(companyId, "empresa sin RFC");
  if (!c.fielCer || !c.fielKey || !c.fielPassword) throw new FielNoDisponibleError(c.rfc, "sin e.firma completa (.cer, .key y contraseña)");
  return {
    rfc: c.rfc.trim().toUpperCase(),
    cer: Buffer.from(decryptSecret(c.fielCer), "base64"),
    key: Buffer.from(decryptSecret(c.fielKey), "base64"),
    pass: decryptSecret(c.fielPassword),
  };
}
