// Base falsa para las pruebas del asistente: el catálogo CIE con las filas que
// las pruebas necesitan (con la misma semántica de `buscarCie`: por código o
// clave, con o sin punto, y la forma «I10.X» de las categorías sin
// subcategoría), un episodio con paciente, signos y notas, y las notas
// ordenadas como pide el `orderBy` de la consulta. Sin Prisma.

import type { HospCatalogoTipo, HospNotaTipo } from "@prisma/client";

export interface FilaCatalogo {
  tipo: HospCatalogoTipo;
  clave: string;
  codigo: string;
  nombre: string;
  nivel: number;
  capitulo: string | null;
  capituloNombre: string | null;
  subtipo: string | null;
  sexo: string | null;
  edadMin: number | null;
  edadMax: number | null;
  activo: boolean;
}

const fila = (tipo: HospCatalogoTipo, clave: string, codigo: string, nombre: string, extra: Partial<FilaCatalogo> = {}): FilaCatalogo => ({
  tipo, clave, codigo, nombre, nivel: 4, capitulo: null, capituloNombre: null, subtipo: null, sexo: null, edadMin: null, edadMax: null, activo: true, ...extra,
});

/** Filas reales del catálogo DGIS (las mismas que carga el seed). */
export const CATALOGO: FilaCatalogo[] = [
  fila("CIE10", "K80", "K80", "COLELITIASIS", { nivel: 3, capitulo: "XI", activo: false, edadMin: 3650, edadMax: 43800 }),
  fila("CIE10", "K802", "K80.2", "CÁLCULO DE LA VESÍCULA BILIAR SIN COLECISTITIS", { capitulo: "XI", edadMin: 3650, edadMax: 43800 }),
  fila("CIE10", "K800", "K80.0", "CÁLCULO DE LA VESÍCULA BILIAR CON COLECISTITIS AGUDA", { capitulo: "XI", edadMin: 3650, edadMax: 43800 }),
  fila("CIE10", "I10X", "I10.X", "HIPERTENSIÓN ESENCIAL (PRIMARIA)", { capitulo: "IX", edadMin: 28, edadMax: 43800 }),
  fila("CIE10", "O800", "O80.0", "PARTO ÚNICO ESPONTÁNEO, PRESENTACIÓN CEFÁLICA DE VÉRTICE", { capitulo: "XV", sexo: "F", edadMin: 3650, edadMax: 19710 }),
  fila("CIE10", "S720", "S72.0", "FRACTURA DEL CUELLO DE FÉMUR", { capitulo: "XIX" }),
  fila("CIE10", "V435", "V43.5", "OCUPANTE DE AUTOMÓVIL LESIONADO POR COLISIÓN CON OTRO AUTOMÓVIL: CONDUCTOR, ACCIDENTE DE TRÁNSITO", { capitulo: "XX" }),
  fila("CIE9MC", "51", "51", "OPERACIONES SOBRE VESÍCULA BILIAR Y TRACTO BILIAR", { nivel: 2, activo: false }),
  fila("CIE9MC", "512", "51.2", "COLECISTECTOMÍA", { nivel: 3, activo: false }),
  fila("CIE9MC", "5123", "51.23", "COLECISTECTOMÍA LAPAROSCÓPICA"),
];

type Where = { tipo: HospCatalogoTipo; OR: Array<{ codigo?: string; clave?: string }> };

export function buscarEnCatalogo(where: Where): FilaCatalogo | null {
  const hits = CATALOGO.filter((f) => f.tipo === where.tipo && where.OR.some((o) => (o.codigo && f.codigo === o.codigo) || (o.clave && f.clave === o.clave)));
  hits.sort((a, b) => Number(b.activo) - Number(a.activo) || a.nivel - b.nivel);
  return hits[0] ?? null;
}

export interface NotaFalsa {
  id: string;
  tipo: HospNotaTipo;
  fecha: Date;
  createdAt?: Date;
  texto: string;
  secciones: Record<string, unknown> | null;
  reemplazadaPor?: { id: string } | null;
}

export interface EpisodioFalso {
  id: string;
  companyId: string;
  folio: string;
  tipo: "HOSPITALIZACION" | "AMBULATORIO" | "URGENCIAS" | "CONSULTA";
  estado: string;
  fechaIngreso: Date;
  fechaAlta: Date | null;
  motivoEgreso: string | null;
  motivo: string | null;
  diagnostico: string | null;
  procedimiento: string | null;
  diagnosticoIngresoCie10: string | null;
  diagnosticoEgresoCie10: string | null;
  procedimientoCie9: string | null;
  asa: string | null;
  aldreteEgreso: number | null;
  paciente: { sexo: "FEMENINO" | "MASCULINO" | "OTRO" | null; fechaNacimiento: Date | null };
  medico: { nombre: string; cedula: string | null; especialidad: string | null } | null;
  signos: Array<Record<string, unknown> & { fecha: Date }>;
  notas: NotaFalsa[];
}

export const EPISODIO_BASE: EpisodioFalso = {
  id: "ep1",
  companyId: "c1",
  folio: "HOSP-2026-0418",
  tipo: "HOSPITALIZACION",
  estado: "POSTOPERATORIO",
  fechaIngreso: new Date("2026-09-04T13:40:00.000Z"),
  fechaAlta: null,
  motivoEgreso: null,
  motivo: "Programada para colecistectomía laparoscópica",
  diagnostico: "Cálculo de vesícula biliar",
  procedimiento: "Colecistectomía laparoscópica",
  diagnosticoIngresoCie10: "K80.2",
  diagnosticoEgresoCie10: null,
  procedimientoCie9: "51.23",
  asa: "I",
  aldreteEgreso: null,
  paciente: { sexo: "FEMENINO", fechaNacimiento: new Date("1992-03-14T18:00:00.000Z") },
  medico: { nombre: "Dr. Alonso Vega", cedula: "5583201", especialidad: "Cirugía general" },
  signos: [{ fecha: new Date("2026-09-05T13:00:00.000Z"), taSistolica: 118, taDiastolica: 76, fc: 72, fr: 16, temperatura: 36.4, spo2: 98, glucosa: null, peso: null, talla: null, dolor: 2 }],
  notas: [],
};

/**
 * Cliente falso con lo que usa el asistente: hospEpisodio.findUnique (aplica
 * el `take` de signos y el `where`/`orderBy` de notas) y hospCatalogo.findFirst.
 */
export function dbFalsa(episodios: EpisodioFalso[] = [EPISODIO_BASE]) {
  return {
    hospEpisodio: {
      findUnique: async ({ where, include }: { where: { id: string }; include?: { signos?: { take?: number }; notas?: false | { orderBy?: unknown } } }) => {
        const ep = episodios.find((e) => e.id === where.id);
        if (!ep) return null;
        const signos = [...ep.signos].sort((a, b) => b.fecha.getTime() - a.fecha.getTime()).slice(0, include?.signos?.take ?? ep.signos.length);
        const notas = include?.notas
          ? ep.notas
              .filter((n) => !n.reemplazadaPor)
              .sort((a, b) => a.fecha.getTime() - b.fecha.getTime() || (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
              .map(({ reemplazadaPor: _r, createdAt: _c, ...n }) => n)
          : undefined;
        return { ...ep, signos, notas };
      },
    },
    hospCatalogo: {
      findFirst: async ({ where }: { where: Where }) => buscarEnCatalogo(where),
    },
  };
}
