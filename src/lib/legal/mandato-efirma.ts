import { isEncrypted } from "@/lib/crypto";

type StoredFiel = {
  fielCer: string | null;
  fielKey: string | null;
  fielPassword: string | null;
};

export type EstadoCredencialMandato =
  | "LISTA"
  | "SIN_EFIRMA"
  | "INCOMPLETA"
  | "REQUIERE_REENCRIPTACION";

export function estadoCredencialParaMandato(
  company: StoredFiel,
): EstadoCredencialMandato {
  const values = [company.fielCer, company.fielKey, company.fielPassword];
  if (values.every((value) => !value)) return "SIN_EFIRMA";
  if (!values.every((value) => typeof value === "string" && value.length > 0)) {
    return "INCOMPLETA";
  }
  return values.every((value) => isEncrypted(value!))
    ? "LISTA"
    : "REQUIERE_REENCRIPTACION";
}
