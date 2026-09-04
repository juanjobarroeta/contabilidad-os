import { withAuthz } from "@/lib/authz";
import { HospitalError } from "./errores";

/**
 * `withAuthz` + los errores de negocio del módulo: un HospitalError(409, …)
 * lanzado desde una regla (cama ocupada, lote sin existencia, folio…) sale
 * como `{ error }` con su código, igual que un AuthzError.
 */
export function withHospital<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>
): (...args: Args) => Promise<Response> {
  return withAuthz(async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (e) {
      if (e instanceof HospitalError) {
        return Response.json({ error: e.message }, { status: e.status });
      }
      throw e;
    }
  });
}
