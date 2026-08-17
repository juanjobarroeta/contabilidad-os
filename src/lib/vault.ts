/**
 * LA BÓVEDA (V-1 de docs/security/PLAN.md) — el ÚNICO lugar del código de
 * aplicación donde una credencial almacenada se descifra.
 *
 * Qué compra este módulo:
 *   1. Un chokepoint: fuera de aquí, importar decryptSecret está prohibido
 *      (lo verifica vault-enforcement.test.ts en cada PR).
 *   2. Propósitos declarados: cada descifrado dice PARA QUÉ es, contra una
 *      allowlist por tipo de credencial. Un propósito nuevo es una decisión
 *      revisable en el diff, no un import silencioso.
 *   3. Bitácora de LECTURAS: cada uso deja fila `credencial.uso` en AuditLog
 *      (tipo, propósito, actor, campos — NUNCA valores). Hasta hoy sólo se
 *      auditaban las escrituras; quién USÓ una llave privada y cuándo era
 *      invisible.
 *
 * Qué NO cambia: la criptografía. Esto delega en decryptSecret tal cual
 * (AES-256-GCM, pass-through de filas legacy en claro). El envelope v2 con
 * AAD y llaves por empresa es V-2, una tarea aparte.
 */
import { decryptSecret } from "./crypto";
import { registrarBitacora } from "./audit";

export const PROPOSITOS = {
  /** e.firma: llave privada ante el SAT. */
  fiel: ["sat-descarga", "syntage-provision"],
  /** Certificado de Sello Digital: se sube al PAC (Facturapi), que timbra. */
  csd: ["facturapi-upload"],
  /** Llave live de la organización Facturapi de la empresa. */
  "facturapi-key": ["pac-call"],
  /** Credencial Playtomic del club (módulo PADEL). */
  "playtomic-key": ["playtomic-call"],
} as const;

export type CredencialTipo = keyof typeof PROPOSITOS;
export type PropositoDe<T extends CredencialTipo> = (typeof PROPOSITOS)[T][number];

/**
 * Propósitos de ALTA frecuencia (una llamada por operación de negocio, p. ej.
 * cada timbrado): la bitácora agrupa en ventanas de una hora por
 * empresa+tipo+propósito para no ahogar las entradas útiles, y reporta
 * `usosAgrupados` en la siguiente fila. Los usos de llaves privadas
 * (fiel/csd) se registran SIEMPRE, uno a uno.
 *
 * La ventana vive en memoria del proceso — misma limitación single-instance
 * que src/lib/rate-limit.ts, y el mismo trade: si el proceso reinicia, lo
 * peor que pasa es una fila de más, nunca una de menos… por ventana.
 */
const ALTA_FRECUENCIA: ReadonlySet<string> = new Set(["pac-call", "playtomic-call"]);
const VENTANA_AGRUPACION_MS = 60 * 60_000;
const ventanas = new Map<string, { desde: number; usos: number }>();

function auditarUso(
  companyId: string,
  tipo: CredencialTipo,
  proposito: string,
  actor: string,
  campos: string[]
): void {
  if (ALTA_FRECUENCIA.has(proposito)) {
    const clave = `${companyId}:${tipo}:${proposito}`;
    const v = ventanas.get(clave);
    const ahora = Date.now();
    if (v && ahora - v.desde < VENTANA_AGRUPACION_MS) {
      v.usos += 1;
      return;
    }
    registrarBitacora({
      companyId,
      accion: "credencial.uso",
      entidad: "Company",
      entidadId: companyId,
      detalle: { tipo, proposito, actor, campos, ...(v ? { usosAgrupados: v.usos } : {}) },
    });
    ventanas.set(clave, { desde: ahora, usos: 0 });
    return;
  }
  registrarBitacora({
    companyId,
    accion: "credencial.uso",
    entidad: "Company",
    entidadId: companyId,
    detalle: { tipo, proposito, actor, campos },
  });
}

/**
 * Descifra una credencial DECLARANDO tipo, propósito y actor, y deja bitácora.
 *
 * `valores` es { campo: valorCifrado }; regresa { campo: valorEnClaro } con
 * las mismas llaves. Lanza si el propósito no está permitido para el tipo o
 * si algún valor viene vacío (el caller debió validar presencia antes — la
 * bóveda no inventa credenciales).
 */
export function abrirCredencial<T extends CredencialTipo, K extends string>(uso: {
  companyId: string;
  tipo: T;
  proposito: PropositoDe<T>;
  /** Quién/qué usa la credencial: "cron:sat-sync", "user:<id>", "sistema". */
  actor?: string;
  valores: Record<K, string>;
}): Record<K, string> {
  const permitidos: readonly string[] = PROPOSITOS[uso.tipo];
  if (!permitidos.includes(uso.proposito)) {
    throw new Error(
      `Propósito «${uso.proposito}» no permitido para credencial ${uso.tipo}. ` +
        `Permitidos: ${permitidos.join(", ")}. Agregar uno nuevo es un cambio de ` +
        `seguridad revisable en src/lib/vault.ts, no un atajo.`
    );
  }
  const campos = Object.keys(uso.valores) as K[];
  for (const campo of campos) {
    if (!uso.valores[campo]) {
      throw new Error(`Credencial ${uso.tipo}: el campo «${campo}» viene vacío.`);
    }
  }

  auditarUso(uso.companyId, uso.tipo, uso.proposito, uso.actor ?? "sistema", campos);

  const abierto = {} as Record<K, string>;
  for (const campo of campos) abierto[campo] = decryptSecret(uso.valores[campo]);
  return abierto;
}

/**
 * Caso especial SIN bitácora: descifrar el .cer (certificado PÚBLICO) sólo
 * para leer su vigencia/RFC. No expone llave privada ni contraseña, y corre
 * en listados (badge de vigencia en cada GET de empresas) — auditarlo
 * ahogaría la bitácora sin proteger nada: el contenido es el mismo
 * certificado que la empresa publica en cada CFDI timbrado.
 */
export function descifrarCerParaVigencia(cifrado: string): string {
  return decryptSecret(cifrado);
}

/** Sólo para tests: resetea las ventanas de agrupación. */
export function _resetVentanasParaTests(): void {
  ventanas.clear();
}
