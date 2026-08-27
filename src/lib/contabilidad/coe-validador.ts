/**
 * Validación estructural del Anexo 24 en RUNTIME.
 *
 * Los tests validan contra xmllint, pero xmllint no existe en producción y
 * los tests se saltan sin él — así que hasta hoy nada impedía DESCARGAR un
 * XML que el SAT iba a rechazar. Este módulo aplica las reglas que de verdad
 * rebotan archivos, con las enumeraciones leídas de los MISMOS XSD que
 * embarcamos (src/lib/contabilidad/xsd/): la validación no puede desfasarse
 * del esquema.
 *
 * No sustituye a xmllint: valida lo material (enums cerradas, partida doble
 * por póliza, formato de RFC), no la gramática XML completa.
 */

import { readFileSync } from "fs";
import path from "path";

export interface ResultadoValidacion {
  ok: boolean;
  errores: string[];
}

let cache: { codAgrup: Set<string>; banco: Set<string> } | null = null;

function enums(): { codAgrup: Set<string>; banco: Set<string> } {
  if (cache) return cache;
  const xsd = readFileSync(
    path.join(process.cwd(), "src/lib/contabilidad/xsd/CatalogosParaEsqContE.xsd"),
    "utf8",
  );
  const extraer = (tipo: string): Set<string> => {
    const m = new RegExp(`name="${tipo}".*?</xs:simpleType>`, "s").exec(xsd);
    if (!m) throw new Error(`Tipo ${tipo} no encontrado en CatalogosParaEsqContE.xsd`);
    return new Set([...m[0].matchAll(/enumeration value="([^"]+)"/g)].map((x) => x[1]));
  };
  cache = { codAgrup: extraer("c_CodAgrup"), banco: extraer("c_Banco") };
  return cache;
}

const RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;

/** Catálogo de cuentas: cada CodAgrup debe pertenecer a la enum cerrada. */
export function validarCatalogoXml(xml: string): ResultadoValidacion {
  const { codAgrup } = enums();
  const errores: string[] = [];
  const malos = new Map<string, number>();
  for (const m of xml.matchAll(/<catalogocuentas:Ctas\s[^>]*CodAgrup="([^"]*)"/g)) {
    if (!codAgrup.has(m[1])) malos.set(m[1], (malos.get(m[1]) ?? 0) + 1);
  }
  for (const [code, n] of malos) {
    errores.push(
      `CodAgrup "${code}" (${n} cuenta${n > 1 ? "s" : ""}) no existe en el catálogo del SAT — el archivo sería rechazado. Asigna el código agrupador real en el catálogo de cuentas.`,
    );
  }
  if (!/<catalogocuentas:Ctas\s/.test(xml)) errores.push("Catálogo sin cuentas.");
  return { ok: errores.length === 0, errores };
}

/** Pólizas: partida doble por póliza, bancos de Transferencia en c_Banco, RFCs bien formados. */
export function validarPolizasXml(xml: string): ResultadoValidacion {
  const { banco } = enums();
  const errores: string[] = [];

  const polizas = xml.split(/<PLZ:Poliza\s/).slice(1);
  for (const bloque of polizas) {
    const id = /NumUnIdenPol="([^"]*)"/.exec(bloque)?.[1] ?? "?";
    let debe = 0;
    let haber = 0;
    for (const m of bloque.matchAll(/<PLZ:Transaccion\s[^>]*Debe="([\d.]+)"\s+Haber="([\d.]+)"/g)) {
      debe += parseFloat(m[1]);
      haber += parseFloat(m[2]);
    }
    if (Math.abs(debe - haber) > 0.011) {
      errores.push(`Póliza ${id}: descuadrada (Debe ${debe.toFixed(2)} ≠ Haber ${haber.toFixed(2)}).`);
    }
    for (const m of bloque.matchAll(/Banco(?:Ori|Dest)Nal="([^"]*)"/g)) {
      if (!banco.has(m[1])) {
        errores.push(`Póliza ${id}: banco "${m[1]}" no existe en c_Banco del SAT.`);
      }
    }
  }
  for (const m of xml.matchAll(/<PLZ:(?:CompNal|Transferencia)\s[^>]*\bRFC="([^"]*)"/g)) {
    if (!RFC_RE.test(m[1])) errores.push(`RFC mal formado en póliza: "${m[1]}".`);
  }
  return { ok: errores.length === 0, errores };
}

/** Balanza: cifras finitas con dos decimales y al menos una cuenta. */
export function validarBalanzaXml(xml: string): ResultadoValidacion {
  const errores: string[] = [];
  let cuentas = 0;
  for (const m of xml.matchAll(/<BCE:Ctas\s[^>]*SaldoIni="([^"]*)"[^>]*Debe="([^"]*)"[^>]*Haber="([^"]*)"[^>]*SaldoFin="([^"]*)"/g)) {
    cuentas++;
    for (const v of m.slice(1, 5)) {
      if (!/^-?\d+\.\d{2}$/.test(v)) errores.push(`Cifra inválida en balanza: "${v}".`);
    }
  }
  if (cuentas === 0) errores.push("Balanza sin cuentas.");
  return { ok: errores.length === 0, errores };
}
