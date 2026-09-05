/**
 * Índice de destinos para la búsqueda global (⌘K).
 *
 * Es deliberadamente MÁS AMPLIO que el menú lateral: incluye las páginas hijas
 * y las pestañas profundas que la barra no muestra (papeles de trabajo,
 * captura de pólizas, historial de declaraciones…). El menú agrupa lo que se
 * usa a diario; este índice tiene que poder llevarte a cualquier parte.
 *
 * `keywords` existe para el vocabulario del contador que NO es el título de la
 * pantalla: quien busca "DIOT" o "CFDI" o "COI" debe llegar, aunque esas
 * palabras no aparezcan en la etiqueta del menú.
 */

export type Destino = {
  href: string;
  label: string;
  /** Sección bajo la que se agrupa en los resultados. */
  grupo: string;
  /** Sinónimos y jerga fiscal que también deben encontrar esta pantalla. */
  keywords?: string[];
  /** Sólo visible para el operador de plataforma. */
  operador?: boolean;
};

export const DESTINOS: Destino[] = [
  // ── Diario ────────────────────────────────────────────────────────────────
  { href: "/dashboard", label: "Hoy", grupo: "General", keywords: ["inicio", "tablero", "dashboard", "resumen", "pendientes de hoy"] },
  { href: "/cierre", label: "Cierre guiado", grupo: "General", keywords: ["cierre", "cierre mensual", "checklist", "pasos", "copiloto"] },
  { href: "/avisos", label: "Avisos", grupo: "General", keywords: ["bandeja", "notificaciones", "inbox", "pendientes"] },
  { href: "/despacho", label: "Cartera", grupo: "General", keywords: ["despacho", "clientes del despacho", "multi rfc"] },

  // ── Operación ─────────────────────────────────────────────────────────────
  { href: "/facturas", label: "Facturas", grupo: "Operación", keywords: ["cfdi", "comprobantes", "emitidas", "recibidas"] },
  { href: "/facturas/nueva", label: "Nueva factura", grupo: "Operación", keywords: ["timbrar", "emitir", "facturar", "cfdi"] },
  { href: "/clientes", label: "Clientes", grupo: "Operación", keywords: ["receptores"] },
  { href: "/proveedores", label: "Proveedores", grupo: "Operación", keywords: ["emisores", "compras"] },
  { href: "/bancos", label: "Bancos", grupo: "Operación", keywords: ["conciliación", "estados de cuenta", "movimientos"] },

  // ── Nómina ────────────────────────────────────────────────────────────────
  { href: "/nomina", label: "Nómina · Resumen", grupo: "Nómina", keywords: ["sueldos", "payroll"] },
  { href: "/nomina?tab=corridas", label: "Nómina · Corridas", grupo: "Nómina", keywords: ["timbrado nómina", "recibos"] },
  { href: "/nomina?tab=empleados", label: "Nómina · Empleados", grupo: "Nómina", keywords: ["trabajadores", "plantilla", "roster"] },
  { href: "/nomina?tab=cumplimiento", label: "Nómina · IMSS y cumplimiento", grupo: "Nómina", keywords: ["imss", "infonavit", "sua", "idse"] },
  { href: "/nomina/ajuste-anual", label: "Ajuste anual de ISR", grupo: "Nómina", keywords: ["isr anual", "ajuste"] },
  { href: "/nomina/cockpit", label: "Tablero multi-RFC de nómina", grupo: "Nómina", keywords: ["cockpit", "despacho"] },

  // ── Fiscal ────────────────────────────────────────────────────────────────
  { href: "/impuestos", label: "Impuestos", grupo: "Fiscal", keywords: ["iva", "isr", "declaraciones", "provisional", "diot"] },
  { href: "/impuestos/papeles", label: "Papeles de trabajo", grupo: "Fiscal", keywords: ["soporte", "cédulas", "workpapers"] },
  { href: "/declaraciones/historial", label: "Historial de declaraciones", grupo: "Fiscal", keywords: ["acuses", "presentadas"] },
  { href: "/contabilidad", label: "Contabilidad", grupo: "Fiscal", keywords: ["balanza", "libro diario", "auxiliares", "coi", "contabilidad electrónica"] },
  { href: "/contabilidad/polizas", label: "Captura de pólizas", grupo: "Fiscal", keywords: ["póliza", "asiento", "diario", "ajuste", "coi"] },
  { href: "/contabilidad/apertura", label: "Apertura contable", grupo: "Fiscal", keywords: ["saldos iniciales", "balance inicial"] },
  { href: "/activos", label: "Activo fijo", grupo: "Fiscal", keywords: ["depreciación", "inpc", "actualización"] },
  { href: "/cumplimiento", label: "Cumplimiento", grupo: "Fiscal", keywords: ["opinión", "32d", "obligaciones"] },
  { href: "/opiniones", label: "Opiniones de cumplimiento", grupo: "Fiscal", keywords: ["32d", "acuse", "positiva"] },
  { href: "/hallazgos", label: "Hallazgos", grupo: "Fiscal", keywords: ["auditor", "riesgos", "observaciones"] },
  { href: "/verificador", label: "Verificador", grupo: "Fiscal", keywords: ["rfc", "curp", "nss", "69-b", "efos", "lista negra"] },

  // ── Configuración ─────────────────────────────────────────────────────────
  { href: "/empresa", label: "Mi empresa", grupo: "Configuración", keywords: ["e.firma", "fiel", "csd", "datos fiscales"] },
  { href: "/configuracion", label: "Configuración", grupo: "Configuración", keywords: ["ajustes", "preferencias"] },
  { href: "/configuracion/empresas", label: "Empresas", grupo: "Configuración", keywords: ["rfc", "alta de empresa"] },
  { href: "/configuracion/usuarios", label: "Usuarios", grupo: "Configuración", keywords: ["equipo", "permisos", "roles"] },
  { href: "/configuracion/invitaciones", label: "Invitaciones", grupo: "Configuración", keywords: ["invitar", "equipo"] },
  { href: "/configuracion/facturacion", label: "Facturación y plan", grupo: "Configuración", keywords: ["suscripción", "pago", "stripe", "plan"] },
  { href: "/configuracion/notificaciones", label: "Notificaciones", grupo: "Configuración", keywords: ["alertas", "push", "correo"] },
  { href: "/configuracion/whatsapp", label: "WhatsApp", grupo: "Configuración", keywords: ["mensajes", "bot"] },
  { href: "/configuracion/codigos", label: "Códigos SAT", grupo: "Configuración", keywords: ["catálogo", "clave producto", "unidad"] },
  { href: "/configuracion/despacho", label: "Despacho", grupo: "Configuración", keywords: ["firma contable", "marca"] },
  { href: "/configuracion/cuenta", label: "Mi cuenta", grupo: "Configuración", keywords: ["perfil", "contraseña"] },

  // ── Operador de plataforma ────────────────────────────────────────────────
  { href: "/rentabilidad", label: "Rentabilidad", grupo: "Operador", operador: true },
  { href: "/creditos", label: "Créditos", grupo: "Operador", operador: true },
  { href: "/operador", label: "Herramientas", grupo: "Operador", operador: true, keywords: ["admin", "interno"] },
];

/**
 * Normaliza para buscar: minúsculas y SIN acentos. Sin esto, "facturacion"
 * (como se teclea de corrido) no encontraría "Facturación", que es
 * exactamente lo que un usuario mexicano escribe con prisa.
 */
export function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Filtra destinos por texto. Puntúa para que un prefijo del título gane a una
 * coincidencia enterrada en las keywords — quien teclea "fac" espera
 * "Facturas" primero, no "Códigos SAT" porque su descripción diga "factura".
 */
export function buscarDestinos(destinos: Destino[], q: string): Destino[] {
  const query = normalizar(q.trim());
  if (!query) return destinos;

  const puntuados: { d: Destino; score: number }[] = [];
  for (const d of destinos) {
    const label = normalizar(d.label);
    const kw = (d.keywords ?? []).map(normalizar);

    let score = -1;
    if (label.startsWith(query)) score = 0;
    else if (label.includes(query)) score = 1;
    else if (kw.some((k) => k.startsWith(query))) score = 2;
    else if (kw.some((k) => k.includes(query))) score = 3;

    if (score >= 0) puntuados.push({ d, score });
  }

  return puntuados
    .sort((a, b) => a.score - b.score || a.d.label.localeCompare(b.d.label))
    .map((p) => p.d);
}
