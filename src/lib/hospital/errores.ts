// Error de negocio del módulo con código HTTP. Sin importar nada: las reglas
// de negocio (episodio, aplicar-insumo, cargos) corren también desde scripts
// con ts-node, donde cargar `@/lib/authz` arrastraría NextAuth entero.
// Las rutas lo vuelven `{ error }` con `withHospital` (with-hospital.ts).
export class HospitalError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "HospitalError";
  }
}
