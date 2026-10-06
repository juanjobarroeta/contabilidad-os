// El tablero de preguntas a la mascota (GET /api/hospital/ayuda/preguntas):
// conteos y repetidas, puro para probarse sin DB.

import { normalizarPregunta } from "./ayuda";

export interface FilaPregunta {
  createdAt: Date;
  pagina: string | null;
  pregunta: string;
  sinRespuesta: boolean;
  util: boolean | null;
}

export function resumirPreguntas(filas: FilaPregunta[]) {
  const resumen = { total: filas.length, utiles: 0, noUtiles: 0, sinValorar: 0, sinRespuesta: 0 };
  const paginas = new Map<string, { pagina: string; total: number; noUtiles: number; sinRespuesta: number }>();
  const grupos = new Map<string, { pregunta: string; veces: number; ultima: Date }>();

  for (const f of filas) {
    if (f.util === true) resumen.utiles++;
    else if (f.util === false) resumen.noUtiles++;
    else resumen.sinValorar++;
    if (f.sinRespuesta) resumen.sinRespuesta++;

    const llave = f.pagina ?? "(sin página)";
    const p = paginas.get(llave) ?? { pagina: llave, total: 0, noUtiles: 0, sinRespuesta: 0 };
    p.total++;
    if (f.util === false) p.noUtiles++;
    if (f.sinRespuesta) p.sinRespuesta++;
    paginas.set(llave, p);

    const n = normalizarPregunta(f.pregunta);
    if (!n) continue;
    const g = grupos.get(n);
    if (g) {
      g.veces++;
      if (f.createdAt > g.ultima) g.ultima = f.createdAt;
    } else {
      grupos.set(n, { pregunta: f.pregunta, veces: 1, ultima: f.createdAt });
    }
  }

  return {
    resumen,
    porPagina: [...paginas.values()].sort((a, b) => b.total - a.total),
    repetidas: [...grupos.values()].filter((g) => g.veces > 1).sort((a, b) => b.veces - a.veces).slice(0, 20),
  };
}
