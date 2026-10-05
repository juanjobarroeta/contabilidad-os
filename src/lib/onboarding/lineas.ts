// ─────────────────────────────────────────────────────────────────────────────
// LO QUE DICE EL COPILOTO EN EL ALTA — tabla tipada, tres tonos por frase.
//
// Narración determinista (docs/onboarding/DISENO-orquestador.md): cada frase es
// función de un evento real × el tono elegido. Sin LLM. Las cifras, avisos y
// confirmaciones son IGUALES en los tres tonos: «Explicado» cambia las
// palabras, nunca omite un riesgo.
//
// Las frases son HTML de confianza (sólo <b>); todo dato que venga del usuario
// o del SAT pasa por `esc`.
// ─────────────────────────────────────────────────────────────────────────────

import type { Perfil, Tono } from "./progreso";

export type Linea = string | Record<Tono, string>;

export function t(l: Linea, tono: Tono): string {
  return typeof l === "string" ? l : l[tono] ?? l.bal;
}

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export const TONOS_INFO: ReadonlyArray<{ id: Tono; label: string; desc: string; barras: number }> = [
  { id: "grano", label: "Al grano", desc: "Directo y técnico. Para quien ya domina.", barras: 1 },
  { id: "bal", label: "Balanceado", desc: "Términos fiscales, con contexto.", barras: 2 },
  { id: "calma", label: "Explicado", desc: "Sin tecnicismos, paso a paso.", barras: 3 },
];

export const VISTA_PREVIA_TONO: Record<Tono, string> = {
  grano: "IVA a cargo $26,667: trasladado $28,512 − acreditable $1,845 (art. 5 LIVA). Sólo acredita CFDI efectivamente pagado.",
  bal: "IVA a cargo: $26,667. Cobraste $28,512 de IVA a tus clientes y restas $1,845 de tus gastos con factura.",
  calma:
    "Este mes pagas $26,667 de IVA. Es el impuesto que les cobraste a tus clientes, menos el que tú pagaste en gastos con factura. Ese dinero no es tuyo: lo guardas para el SAT.",
};

export const LINEAS = {
  // 01 · Bienvenida
  hola: (nombre: string) =>
    `Soy <b>${esc(nombre)}</b>, tu copiloto. Tardamos unos cinco minutos; lo pesado lo hago yo. Para empezar: ¿quién eres?`,
  perfil: (p: Perfil) =>
    p === "despacho"
      ? "Perfecto. Damos de alta a tu primer cliente y los demás te tomarán minutos."
      : "Perfecto. Vamos a dejar tu empresa al día.",

  // 02 · Personaje
  personaje: "Antes de empezar, elige cómo quieres que me vea. Pruébalos todos: no me ofendo.",
  invitado: (despacho: string, nombre: string) =>
    `Te invitó <b>${esc(despacho)}</b>. Soy <b>${esc(nombre)}</b>, tu copiloto. Antes de empezar, elige cómo quieres que me vea.`,
  personajeLinea: {
    blob: "Clásico y sobrio. Me gusta.",
    shiba: "Mochi, a tus órdenes. Leal y atento a cada factura.",
    owl: "Lupa. Ningún centavo se me escapa.",
  } as Record<string, string>,
  nombre: (n: string) => `<b>${esc(n)}</b>. Me gusta cómo suena.`,
  tono: {
    grano: "Al grano. Cifras, fundamento y listo.",
    bal: "Balanceado. Te digo el término y lo que significa.",
    calma: "Con calma. Te explico cada cosa sin palabras raras, y si algo no queda claro, me preguntas.",
  } satisfies Linea,

  // 03 · Confianza
  confianza: {
    grano: "Antes de la e.firma: alcance y permisos.",
    bal: "Antes de pedirte tu e.firma, quiero que sepas exactamente cómo trabajo.",
    calma: "Antes de pedirte nada, te cuento cómo trabajo. Es importante que confíes en mí, así que voy despacio.",
  } satisfies Linea,
  confianzaFin: "Si algún día necesito hacer algo distinto, <b>te lo pregunto primero</b>.",

  // 04 · e.firma
  fiel: {
    grano: "Sube <b>.cer</b>, <b>.key</b> y contraseña. Uso la e.firma para descarga masiva (WS SAT).",
    bal: "Necesito los dos archivos de tu e.firma: el <b>.cer</b> y el <b>.key</b>. Están donde la guardaste cuando la tramitaste en el SAT.",
    calma:
      "La e.firma son dos archivitos que te dio el SAT: uno termina en <b>.cer</b> y otro en <b>.key</b>. Suelen estar en una USB o en una carpeta llamada «FIEL». Si no los encuentras, tu contador los tiene.",
  } satisfies Linea,
  fielPorQue:
    "Con la contraseña del SAT (CIEC) sólo veo facturas sueltas. Con la e.firma puedo hacer la <b>descarga masiva</b> de cinco años y verificar cuáles se cancelaron.",
  certLeido: (razon: string, rfc: string, hasta: string | null) =>
    `Leí tu certificado: <b>${esc(razon)}</b>, RFC ${esc(rfc)}${hasta ? `, vigente hasta ${esc(hasta)}` : ""}.`,
  llave: "Ahora la contraseña de la llave. Viaja cifrada y se guarda cifrada.",
  validando: "Validando tu e.firma…",
  fielError: (msg: string) => `No pude validarla: ${esc(msg)}`,
  leyendoCsf: {
    grano: "e.firma válida. Bajo tu CSF para régimen y CP.",
    bal: "Tu e.firma es válida. Ahora le pido al SAT tu <b>constancia de situación fiscal</b> para no preguntarte tu régimen.",
    calma: "¡Tu e.firma funciona! Ahora le pido al SAT tu <b>constancia fiscal</b>, el papel que dice a qué te dedicas, para no preguntarte nada que él ya sabe.",
  } satisfies Linea,
  confirmaDatos: "No pude leer tu constancia del SAT. Confírmame <b>dos datos</b> y seguimos.",
  creando: "Dando de alta tu empresa y conectándome al SAT…",
  conectado: "Conectado al SAT.",
  opinion: {
    grano: "Consulto la <b>opinión 32-D</b>.",
    bal: "Ya que estoy dentro, le pido tu <b>opinión de cumplimiento</b>. Tarda unos segundos.",
    calma: "Ya que estoy dentro, le pregunto al SAT si estás <b>al corriente</b>. Es como un certificado de buena conducta fiscal; tarda unos segundos.",
  } satisfies Linea,
  opinionResultado: (r: string): Linea => {
    if (r === "POSITIVA") {
      return {
        grano: "32-D positiva. Sigo con el backfill.",
        bal: "Positiva: el SAT te ve al corriente. Buen comienzo. Ahora, tu historial.",
        calma: "¡Positiva! Quiere decir que el SAT no ve nada pendiente contigo. Tus clientes te la pueden pedir, y ya la tienes. Ahora traigo tu historial.",
      };
    }
    if (r === "NEGATIVA") {
      return {
        grano: "32-D <b>negativa</b>. Te dejo los motivos en Cumplimiento. Sigo con el backfill.",
        bal: "Tu opinión salió <b>negativa</b>: el SAT ve algo pendiente. Te dejo los motivos en Cumplimiento y lo vemos juntos. Ahora, tu historial.",
        calma: "Tu opinión salió <b>negativa</b>: el SAT cree que algo quedó pendiente. No te preocupes ahora; te dejo los motivos en Cumplimiento para revisarlos juntos. Ahora traigo tu historial.",
      };
    }
    return "No obtuve una opinión clara del SAT; la vuelvo a pedir más tarde desde Cumplimiento. Ahora, tu historial.";
  },
  opinionNoDisponible: "No pude consultar tu opinión de cumplimiento ahora; la pido más tarde desde Cumplimiento. Sigo con tu historial.",

  // 05 · Historial
  historial: {
    grano: "Backfill: CFDI, declaraciones y CE (Anexo 24), de lo reciente a lo antiguo.",
    bal: "Bajo tres cosas: tus <b>facturas</b>, tus <b>declaraciones</b> y tu <b>contabilidad electrónica</b>. Empiezo por lo más reciente.",
    calma:
      "Ahora traigo tres cosas del SAT: tus <b>facturas</b>, lo que <b>declaraste</b> cada mes y tu <b>contabilidad</b> que ya se envió. Empiezo por lo más reciente para que puedas usar la app pronto.",
  } satisfies Linea,
  historialReciente: "Ya tengo lo reciente: puedo calcular tus impuestos del mes. <b>Si quieres, sigue tú</b>; yo continúo con el resto.",
  teAviso: "Listo: te aviso cuando tenga lo reciente y cuando termine tu historial. Ya puedes seguir.",
  historialSinFiel: "Sin e.firma no puedo descargar tu historial. Cuando la conectes en Configuración, empiezo solo.",

  // 06 · Bancos
  bancos: "Mientras bajo tu historial: ¿registramos tu cuenta de banco? Es opcional, pero con ella tu balance también cuadra.",
  bancoElegido: (b: string) => `${esc(b)}. Dime cómo se llama la cuenta y su número; <b>nunca te pido la contraseña de tu banco.</b>`,
  bancoListo:
    "Listo. Sube tu estado de cuenta en Bancos y cruzo cada depósito con su factura; te aviso lo que no cuadre.",

  // 07 · Equipo
  equipo: (p: Perfil | null) =>
    p === "despacho" ? "¿Trabajas con más personas? Invítalas y nos repartimos las empresas." : "¿Tienes contador? Invítalo: trabajamos los tres juntos.",
  equipoVacio: "Escribe al menos un correo, o déjalo para después.",
  equipoListo: "Listo: ya tienen acceso. Compárteles sus datos de entrada; cuando entren, les presento todo como a ti.",

  // 08 · WhatsApp
  whatsapp: (nombre: string) =>
    `Última: conecta tu WhatsApp. Entre semana te mando a las 8 el resumen de tus empresas, te aviso lo urgente, y me puedes preguntar o mandar facturas desde ahí. Soy el mismo <b>${esc(nombre)}</b>.`,
  whatsappAbierto: "Manda el mensaje tal cual aparece en WhatsApp; aquí me entero en cuanto llegue.",
  whatsappListo: "Conectado. Mañana a las 8 te llega el primer resumen.",
  whatsappNoDisponible: "WhatsApp todavía no está disponible en esta cuenta. Lo conectas después desde Configuración.",

  // Recorrido (dentro de la app) y app
  recorridoInicio: "Ahora te enseño dónde está cada cosa. Son unos pasos; puedes saltarlo cuando quieras.",
  arrastreFallido: "Casi. Suéltame <b>encima</b> de la tarjeta resaltada.",
  arrastreBien: {
    grano: "Así: me sueltas sobre un dato y te lo explico con tus cifras. <b>Funciona en cualquier pantalla.</b>",
    bal: "Así funciono: me sueltas sobre una cifra y te explico de dónde sale, con tus datos. <b>Funciona en cualquier pantalla.</b>",
    calma: "¡Eso! Cuando algo no se entienda, me arrastras encima y te lo explico con tus números. <b>Puedes hacerlo en cualquier pantalla.</b>",
  } satisfies Linea,
} as const;
