/** Structure/check digit only; this does not verify account ownership. */
export function leerClabe(value: unknown): { ok: true; clabe: string | null } | { ok: false; error: string } {
  if (value == null || value === "") return { ok: true, clabe: null };
  if (typeof value !== "string") return { ok: false, error: "La CLABE debe tener 18 dígitos numéricos." };
  const clabe = value.replace(/\s/g, "");
  if (!clabe) return { ok: true, clabe: null };
  if (!/^\d{18}$/.test(clabe)) return { ok: false, error: "La CLABE debe tener 18 dígitos numéricos." };
  // Modulo 10, repeating weights 3/7/1 over the first 17 digits.
  // https://www.bancanetempresarial.banamex.com.mx/spanishdir/bankhelp/hlp_archivoscargosdomicilia.htm
  const sum = [...clabe.slice(0, 17)].reduce((total, digit, i) => total + Number(digit) * [3, 7, 1][i % 3], 0);
  if ((10 - sum % 10) % 10 !== Number(clabe[17])) return { ok: false, error: "El dígito verificador de la CLABE no coincide. Revisa los 18 dígitos." };
  return { ok: true, clabe };
}
