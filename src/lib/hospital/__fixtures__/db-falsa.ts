// Base en memoria para probar la contabilidad del hospital sin Postgres: las
// tablas que tocan contabilidad.ts, contabilidad/hospital.ts y asientos.ts,
// con un `where` reducido (igualdad, in/not, gte/lt, startsWith, OR y la
// relación episodio de los cargos). Sólo para tests.

import { definicionCatalogo } from "../contabilidad";

type Fila = Record<string, unknown>;

const valor = (x: unknown) => (x instanceof Date ? x.getTime() : x);

export function coincide(fila: Fila, where: Fila | undefined, db: DbFalsa): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (k === "OR") {
      if (!(v as Fila[]).some((w) => coincide(fila, w, db))) return false;
      continue;
    }
    if (k === "episodio") {
      const ep = db.episodios.find((e) => e.id === fila.episodioId);
      if (!ep || !coincide(ep, v as Fila, db)) return false;
      continue;
    }
    if (k === "invoice") {
      const inv = db.invoices.find((i) => i.id === fila.invoiceId);
      if (!inv || !coincide(inv, v as Fila, db)) return false;
      continue;
    }
    if (k === "liquidacion") {
      const liq = db.liquidaciones.find((l) => l.id === fila.liquidacionId);
      if (!liq || !coincide(liq, v as Fila, db)) return false;
      continue;
    }
    const actual = fila[k];
    if (v === null) {
      if (actual != null) return false;
      continue;
    }
    if (v instanceof Date || typeof v !== "object") {
      if (valor(actual) !== valor(v)) return false;
      continue;
    }
    const cond = v as Fila;
    if ("in" in cond && !(cond.in as unknown[]).map(valor).includes(valor(actual))) return false;
    if ("notIn" in cond && (cond.notIn as unknown[]).map(valor).includes(valor(actual))) return false;
    if ("not" in cond) {
      if (cond.not === null ? actual == null : valor(actual) === valor(cond.not)) return false;
    }
    if ("gte" in cond && !((valor(actual) as number) >= (valor(cond.gte) as number))) return false;
    if ("gt" in cond && !((valor(actual) as number) > (valor(cond.gt) as number))) return false;
    if ("lt" in cond && !((valor(actual) as number) < (valor(cond.lt) as number))) return false;
    if ("lte" in cond && !((valor(actual) as number) <= (valor(cond.lte) as number))) return false;
    if ("startsWith" in cond && !String(actual).startsWith(String(cond.startsWith))) return false;
  }
  return true;
}

/** Defaults del esquema que Prisma pondría al crear. */
const DEFAULTS: Record<string, Fila> = {
  cuentas: { isActive: true, codAgrup: null, naturaleza: null, subcuenta: null, nivel: 1 },
  depositos: { estado: "RECIBIDO", aplicadoAt: null, devueltoAt: null, asientoAt: null, referencia: null, notas: null },
  movimientos: { asientoAt: null },
  cargos: { asientoAt: null, cancelado: false },
};

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

export interface CuentaFalsa {
  id: string;
  companyId: string;
  cuentaSAT: string;
  subcuenta: string | null;
  nombre: string;
  tipo: string;
  nivel: number;
  naturaleza: string | null;
  codAgrup: string | null;
  isActive: boolean;
  createdAt: Date;
}

export class DbFalsa {
  companyId = "c1";
  rfc = "HOS010101AB1"; // persona moral (12)
  configRow: { contabilidadActiva: boolean; cuentasContables: unknown } | null = { contabilidadActiva: true, cuentasContables: null };
  cuentas: CuentaFalsa[] = [];
  overrides: Array<{ id: string; companyId: string; codigoMotor: string; chartAccountId: string }> = [];
  asientos: Fila[] = [];
  periodos: Array<{ companyId: string; year: number; month: number; status: string }> = [];
  movimientos: Fila[] = [];
  cargos: Fila[] = [];
  depositos: Fila[] = [];
  episodios: Fila[] = [];
  medicos: Fila[] = [];
  insumos: Fila[] = [];
  lotes: Fila[] = [];
  invoices: Fila[] = [];
  cobros: Fila[] = [];
  liquidaciones: Fila[] = [];
  afiliaciones: Fila[] = [];

  /** Siembra cuentas del catálogo del SAT por código. */
  sembrar(codigos: string[], companyId = this.companyId) {
    for (const codigo of codigos) {
      const def = definicionCatalogo(codigo);
      if (!def) throw new Error(`sin definición para ${codigo}`);
      this.cuentas.push({
        id: id("cta"),
        companyId,
        cuentaSAT: def.cuentaSAT,
        subcuenta: def.subcuenta,
        nombre: def.nombre,
        tipo: def.tipo,
        nivel: def.nivel,
        naturaleza: null,
        codAgrup: null,
        isActive: true,
        createdAt: new Date(),
      });
    }
    return this;
  }

  cuentaPorCodigo(codigo: string) {
    return this.cuentas.find((c) => (c.subcuenta ?? c.cuentaSAT) === codigo) ?? null;
  }

  private conRelaciones(tabla: string, fila: Fila): Fila {
    const out = { ...fila };
    if (tabla === "overrides") out.cuenta = this.cuentas.find((c) => c.id === fila.chartAccountId) ?? null;
    if (tabla === "cargos") {
      const m = this.medicos.find((x) => x.id === fila.medicoId) ?? null;
      out.medico = m;
      out.episodio = this.episodios.find((e) => e.id === fila.episodioId) ?? null;
    }
    if (tabla === "movimientos") {
      out.insumo = this.insumos.find((i) => i.id === fila.insumoId) ?? { nombre: "insumo" };
      out.lote = this.lotes.find((l) => l.id === fila.loteId) ?? null;
    }
    if (tabla === "depositos") out.episodio = this.episodios.find((e) => e.id === fila.episodioId) ?? { folio: "?" };
    if (tabla === "cobros") out.episodio = this.episodios.find((e) => e.id === fila.episodioId) ?? null;
    if (tabla === "liquidaciones") out.afiliacion = this.afiliaciones.find((a) => a.id === fila.afiliacionId) ?? { numero: "?" };
    if (tabla === "asientos") out.chartAccount = this.cuentas.find((c) => c.id === fila.chartAccountId) ?? null;
    return out;
  }

  private tabla(nombre: string, filas: Fila[]) {
    const defaults: Fila = DEFAULTS[nombre] ?? {};
    return {
      findMany: async (args: { where?: Fila; take?: number; distinct?: string[] } = {}) => {
        let hits = filas.filter((f) => coincide(f, args.where, this));
        if (args.distinct) {
          const vistos = new Set<string>();
          hits = hits.filter((f) => {
            const k = args.distinct!.map((d) => String(f[d])).join("|");
            if (vistos.has(k)) return false;
            vistos.add(k);
            return true;
          });
        }
        return (args.take ? hits.slice(0, args.take) : hits).map((f) => this.conRelaciones(nombre, f));
      },
      findFirst: async (args: { where?: Fila; orderBy?: Fila } = {}) => {
        const hits = filas.filter((f) => coincide(f, args.where, this));
        if (hits.length === 0) return null;
        const fila = args.orderBy && (args.orderBy as { createdAt?: string }).createdAt === "desc" ? hits[hits.length - 1] : hits[0];
        return this.conRelaciones(nombre, fila);
      },
      findUnique: async (args: { where: Fila }) => {
        const w = args.where;
        const fila = filas.find((f) => (w.id != null ? f.id === w.id : coincide(f, w, this)));
        return fila ? this.conRelaciones(nombre, fila) : null;
      },
      findUniqueOrThrow: async (args: { where: Fila }) => {
        const fila = filas.find((f) => f.id === args.where.id);
        if (!fila) throw new Error("no encontrado");
        return this.conRelaciones(nombre, fila);
      },
      create: async (args: { data: Fila }) => {
        const fila: Fila = { id: id(nombre), createdAt: new Date(), ...defaults, ...args.data };
        filas.push(fila);
        return this.conRelaciones(nombre, fila);
      },
      createMany: async (args: { data: Fila[] }) => {
        for (const d of args.data) filas.push({ id: id(nombre), createdAt: new Date(), ...defaults, ...d });
        return { count: args.data.length };
      },
      update: async (args: { where: Fila; data: Fila }) => {
        const fila = filas.find((f) => f.id === args.where.id);
        if (!fila) throw new Error("no encontrado");
        Object.assign(fila, args.data);
        return this.conRelaciones(nombre, fila);
      },
      updateMany: async (args: { where: Fila; data: Fila }) => {
        let n = 0;
        for (const f of filas) {
          if (coincide(f, args.where, this)) {
            Object.assign(f, args.data);
            n++;
          }
        }
        return { count: n };
      },
      upsert: async (args: { where: Fila; update: Fila; create: Fila }) => {
        const fila = filas.find((f) => coincide(f, args.where, this));
        if (fila) {
          Object.assign(fila, args.update);
          return fila;
        }
        const nueva: Fila = { id: id(nombre), createdAt: new Date(), ...defaults, ...args.create };
        filas.push(nueva);
        return nueva;
      },
      deleteMany: async (args: { where: Fila }) => {
        const antes = filas.length;
        const quedan = filas.filter((f) => !coincide(f, args.where, this));
        filas.length = 0;
        filas.push(...quedan);
        return { count: antes - quedan.length };
      },
    };
  }

  get hospConfig() {
    return {
      findUnique: async () => (this.configRow ? { ...this.configRow } : null),
    };
  }
  get company() {
    return { findUnique: async () => ({ rfc: this.rfc }) };
  }
  get postingCuentaOverride() {
    const base = this.tabla("overrides", this.overrides as unknown as Fila[]);
    return {
      ...base,
      findUnique: async (args: { where: { companyId_codigoMotor: { companyId: string; codigoMotor: string } } }) => {
        const w = args.where.companyId_codigoMotor;
        const o = this.overrides.find((x) => x.companyId === w.companyId && x.codigoMotor === w.codigoMotor);
        return o ? { ...o, cuenta: this.cuentas.find((c) => c.id === o.chartAccountId) ?? null } : null;
      },
    };
  }
  get chartAccount() {
    return this.tabla("cuentas", this.cuentas as unknown as Fila[]);
  }
  get accountingEntry() {
    return this.tabla("asientos", this.asientos);
  }
  get accountingPeriod() {
    return {
      findUnique: async (args: { where: { companyId_year_month: { companyId: string; year: number; month: number } } }) => {
        const w = args.where.companyId_year_month;
        return this.periodos.find((p) => p.companyId === w.companyId && p.year === w.year && p.month === w.month) ?? null;
      },
    };
  }
  get hospMovimientoInsumo() {
    return this.tabla("movimientos", this.movimientos);
  }
  get hospCargo() {
    return this.tabla("cargos", this.cargos);
  }
  get hospDeposito() {
    return this.tabla("depositos", this.depositos);
  }
  get hospCobro() {
    return this.tabla("cobros", this.cobros);
  }
  get hospLiquidacion() {
    return this.tabla("liquidaciones", this.liquidaciones);
  }
  get hospAfiliacion() {
    return this.tabla("afiliaciones", this.afiliaciones);
  }
  get hospEpisodio() {
    return this.tabla("episodios", this.episodios);
  }
  get invoice() {
    return this.tabla("invoices", this.invoices);
  }
  $transaction<T>(fn: (tx: DbFalsa) => Promise<T>): Promise<T> {
    return fn(this);
  }

  /** Pares CARGO/ABONO del libro, ordenados como se escribieron. */
  pares() {
    const out: Array<{ referencia: string; referenciaTipo: string; monto: number; cargo: string; abono: string; year: number; month: number }> = [];
    for (let i = 0; i < this.asientos.length; i += 2) {
      const a = this.asientos[i];
      const b = this.asientos[i + 1];
      const codigo = (f: Fila) => {
        const c = this.cuentas.find((x) => x.id === f.chartAccountId)!;
        return c.subcuenta ?? c.cuentaSAT;
      };
      out.push({
        referencia: String(a.referencia),
        referenciaTipo: String(a.referenciaTipo),
        monto: Number(a.monto),
        cargo: codigo(a.tipo === "CARGO" ? a : b),
        abono: codigo(a.tipo === "ABONO" ? a : b),
        year: Number(a.year),
        month: Number(a.month),
      });
    }
    return out;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const comoDb = (db: DbFalsa) => db as unknown as any;
