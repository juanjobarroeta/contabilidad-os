#!/usr/bin/env node
// SessionStart hook — inyecta la fecha actual y contexto fiscal MX derivado, para
// que Claude razone sobre períodos abiertos, plazos y cobertura de datos (INPC)
// sin que el usuario tenga que repetir la fecha. stdout de un hook SessionStart se
// agrega al contexto de la sesión. Sin dependencias (solo Node + Intl).
//
// Las fechas se calculan en America/Mexico_City sin importar el TZ del contenedor.
// Es contexto ORIENTATIVO (reglas generales del calendario fiscal); para un cálculo
// que dependa de un plazo, verifica la fecha oficial (puede recorrerse por inhábil).

const now = new Date();
const f = (opts) =>
  new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", ...opts }).format(now);

const y = Number(f({ year: "numeric" }));
const m = Number(f({ month: "numeric" })); // 1-12
const d = Number(f({ day: "numeric" }));
const fechaLarga = f({ weekday: "long", year: "numeric", month: "long", day: "numeric" });

const meses = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const ym = (yy, mm) => `${yy}-${String(mm).padStart(2, "0")}`;
const mesAnterior = (yy, mm) => (mm === 1 ? [yy - 1, 12] : [yy, mm - 1]);
const mesSiguiente = (yy, mm) => (mm === 12 ? [yy + 1, 1] : [yy, mm + 1]);

// Declaraciones mensuales (IVA / ISR provisional / DIOT): vencen el día 17 del mes
// siguiente al período. Hasta el 17 se presenta el mes anterior; pasado el 17 ese
// ya se presentó y el siguiente período en juego es el mes en curso.
let periodoMensual, limiteMensual;
if (d <= 17) {
  const [py, pm] = mesAnterior(y, m);
  periodoMensual = ym(py, pm);
  limiteMensual = `17 de ${meses[m - 1]} de ${y}`;
} else {
  periodoMensual = ym(y, m);
  const [ny, nm] = mesSiguiente(y, m);
  limiteMensual = `17 de ${meses[nm - 1]} de ${ny}`;
}

// INPC: INEGI publica el INPC del mes M alrededor del día 9 del mes M+1. El último
// publicado esperado es el mes anterior (o dos meses atrás si aún no llega el 9).
let [iy, im] = mesAnterior(y, m);
if (d < 9) [iy, im] = mesAnterior(iy, im);
const inpcUltimo = ym(iy, im);

const ejercicioAnterior = y - 1;

const lineas = [
  `Fecha actual (America/Mexico_City): ${fechaLarga} — ${ym(y, m)}-${String(d).padStart(2, "0")}.`,
  `Contexto fiscal MX derivado de la fecha (orientativo, para razonar plazos y cobertura de datos):`,
  `- Mensuales (IVA / ISR provisional / DIOT): período natural en juego ${periodoMensual}; fecha límite ${limiteMensual}.`,
  `- Anual: ejercicio en curso ${y}. Última anual presentable: ejercicio ${ejercicioAnterior} (PM venció 31-mar-${y}; PF 30-abr-${y}).`,
  `- INPC: el último publicado por INEGI debería ser ${inpcUltimo}. Si el seed no lo cubre, la actualización por INPC (Art. 57, depreciación) y la cobertura quedan desfasadas.`,
];

process.stdout.write(lineas.join("\n") + "\n");
