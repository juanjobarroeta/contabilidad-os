// ─────────────────────────────────────────────────────────────────────────────
// Cuentas bancarias que la empresa YA declaró en su catálogo de cuentas (la
// Contabilidad Electrónica presentada al SAT): las subcuentas de bancos
// (agrupador 102.01 nacionales / 102.02 extranjeros). Cada una que todavía no
// es una cuenta bancaria en la app se sugiere para registrarla, ya ligada a su
// cuenta contable (BankAccount.chartAccountId) — así el saldo de bancos vive en
// la cuenta que su contabilidad conoce, no en una que inventa el motor.
//
// Puro: la ruta junta catálogo y cuentas existentes.
// ─────────────────────────────────────────────────────────────────────────────

export interface CuentaCatalogo {
  id: string;
  cuentaSAT: string;
  subcuenta: string | null;
  nombre: string;
  codAgrup: string | null;
  padreCodigo: string | null;
  isActive: boolean;
}

export interface CuentaBancariaExistente {
  chartAccountId: string | null;
  numeroCuenta: string;
  clabe: string | null;
}

export interface SugerenciaCuentaBancaria {
  chartAccountId: string;
  codigo: string;
  nombre: string;
  banco: string | null;
  /** Dígitos de cuenta que trae el nombre (≥ 4), si trae. */
  numero: string | null;
  moneda: "MXN" | "USD";
}

// Nombre comercial → cómo se escribe en el catálogo. El primero que aparece gana.
const BANCOS: Array<[string, RegExp]> = [
  ["BBVA", /\b(bbva|bancomer)\b/i],
  ["Banamex", /\b(banamex|citibanamex|citi)\b/i],
  ["Santander", /\bsantander\b/i],
  ["Banorte", /\b(banorte|ixe)\b/i],
  ["HSBC", /\bhsbc\b/i],
  ["Scotiabank", /\b(scotiabank|scotia)\b/i],
  ["Inbursa", /\binbursa\b/i],
  ["BanBajío", /\b(banbaj[ií]o|baj[ií]o)\b/i],
  ["Banregio", /\bbanregio\b/i],
  ["Afirme", /\bafirme\b/i],
  ["Banco Azteca", /\bazteca\b/i],
  ["Mifel", /\bmifel\b/i],
  ["Monex", /\bmonex\b/i],
  ["Multiva", /\bmultiva\b/i],
  ["Intercam", /\bintercam\b/i],
  ["BanCoppel", /\bbancoppel\b/i],
  ["Ve por Más", /\b(ve por m[aá]s|bx\+)/i],
  ["Actinver", /\bactinver\b/i],
  ["Banco Base", /\bbanco base\b/i],
  ["Sabadell", /\bsabadell\b/i],
  ["Hey Banco", /\bhey\b/i],
  ["Mercado Pago", /\bmercado ?pago\b/i],
  ["STP", /\bstp\b/i],
];

export function bancoDeNombre(nombre: string): string | null {
  for (const [banco, re] of BANCOS) if (re.test(nombre)) return banco;
  return null;
}

/** La corrida de dígitos más larga (≥ 4) del nombre: «BBVA 0123454821» → 0123454821. */
export function numeroDeNombre(nombre: string): string | null {
  const corridas = nombre.match(/\d[\d\s-]*\d|\d/g) ?? [];
  let mejor = "";
  for (const c of corridas) {
    const d = c.replace(/\D/g, "");
    if (d.length > mejor.length) mejor = d;
  }
  return mejor.length >= 4 ? mejor : null;
}

const codigoDe = (c: CuentaCatalogo) => c.subcuenta ?? c.cuentaSAT;

/** ¿Es subcuenta de bancos? Por el agrupador del SAT; sin él, por el código 102. */
function esDeBancos(c: CuentaCatalogo): boolean {
  if (c.codAgrup) return /^102\.0[12]/.test(c.codAgrup);
  return c.cuentaSAT === "102" && !!c.subcuenta;
}

export function sugerirCuentasBancarias(
  catalogo: CuentaCatalogo[],
  existentes: CuentaBancariaExistente[],
): SugerenciaCuentaBancaria[] {
  // Una cuenta que es padre de otra agrupa: la cuenta bancaria es la hoja.
  const padres = new Set(catalogo.map((c) => c.padreCodigo).filter((p): p is string => !!p));
  const ligadas = new Set(existentes.map((e) => e.chartAccountId).filter((x): x is string => !!x));
  const numeros = existentes.flatMap((e) => [e.numeroCuenta, e.clabe ?? ""]).map((n) => n.replace(/\D/g, "")).filter((n) => n.length >= 6);

  const out: SugerenciaCuentaBancaria[] = [];
  for (const c of catalogo) {
    if (!c.isActive || !esDeBancos(c) || padres.has(codigoDe(c)) || ligadas.has(c.id)) continue;
    const numero = numeroDeNombre(c.nombre);
    // Ya registrada con su número completo (o su CLABE lo contiene).
    if (numero && numero.length >= 6 && numeros.some((n) => n === numero || n.endsWith(numero) || numero.endsWith(n))) continue;
    const usd = c.codAgrup?.startsWith("102.02") || /\b(usd|d[oó]lar|dlls?)\b/i.test(c.nombre);
    out.push({ chartAccountId: c.id, codigo: codigoDe(c), nombre: c.nombre, banco: bancoDeNombre(c.nombre), numero, moneda: usd ? "USD" : "MXN" });
  }
  return out.sort((a, b) => a.codigo.localeCompare(b.codigo));
}
