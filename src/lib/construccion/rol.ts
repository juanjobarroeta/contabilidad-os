/**
 * Enforcement del rol de construcción (CompanyMember.construccionRol) para
 * las rutas /api/construccion/*.
 *
 * Modelo: allowlist por rol de patrones (método, ruta). Todo lo que no está
 * listado se rechaza con 403. `construccionRol` null o ADMIN = sin
 * restricción (el MemberRole normal manda, como hasta ahora).
 *
 * Se aplica en UN solo choke point: requireMembership (src/lib/authz.ts)
 * llama a enforceConstruccionRol cuando la petición trae Request y el
 * miembro directo tiene rol de construcción restringido. Toda ruta de
 * /api/construccion/* pasa por requireMembership con `req`, así que la
 * cobertura es total sin tocar cada handler.
 *
 * Los patrones se expresan como el path DESPUÉS de /api/construccion/;
 * `*` = exactamente un segmento. Sin sufijo = exact match.
 */

import { AuthzError } from "../authz";
import type { ConstruccionRol } from "@prisma/client";

type Rule = { methods: "read" | "write" | "all"; pattern: string };

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * TESORERÍA (p. ej. Katia): sólo la cola de pagos que admin ya mandó a
 * tesorería — ver y ejecutar pagos, vincular movimientos bancarios y
 * consultar el contexto que esa pantalla necesita (proveedores, CFDIs,
 * saldos de bancos, adjudicaciones). Nada de presupuestos, obras (escritura),
 * requisiciones (decisiones), gastos, destajo ni reportes.
 */
const TESORERIA_RULES: Rule[] = [
  // Notificaciones push: cualquiera activa/desactiva las suyas
  { methods: "all", pattern: "push" },
  // Contexto de sólo lectura que usa la pantalla de pagos
  { methods: "read", pattern: "proyectos" },
  { methods: "read", pattern: "proyectos/*" },
  { methods: "read", pattern: "suppliers" },
  { methods: "read", pattern: "suppliers/*" },
  { methods: "read", pattern: "cfdis" },
  { methods: "read", pattern: "cfdis/*" },
  { methods: "read", pattern: "bank-accounts" },
  { methods: "read", pattern: "bank-transactions" },
  { methods: "read", pattern: "gastos" },
  { methods: "read", pattern: "gastos/*" },
  { methods: "read", pattern: "gastos/*/comprobante" },
  // Pagar un gasto aprobado desde su cola (mismo flujo que las compras)
  { methods: "all", pattern: "gastos/*/aprobar-pagar" },
  { methods: "read", pattern: "solicitudes-compra" },
  { methods: "read", pattern: "solicitudes-compra/*" },
  { methods: "read", pattern: "solicitudes-compra/*/bt-candidates" },
  { methods: "read", pattern: "adjudicaciones" },
  { methods: "read", pattern: "adjudicaciones/*" },
  // Acciones de pago
  { methods: "all", pattern: "cuentas-por-pagar" },
  { methods: "all", pattern: "cuentas-por-pagar/*" },
  { methods: "all", pattern: "pagos-proveedor" },
  { methods: "all", pattern: "pagos-proveedor/*" },
  { methods: "all", pattern: "solicitudes-compra/*/pagar" },
  { methods: "all", pattern: "solicitudes-compra/*/vincular-bt" },
];

/**
 * RESIDENTE: genera y da seguimiento a sus requisiciones; lee (nunca edita)
 * presupuestos, precios unitarios y APUs; ve caja chica; y nada más. Las
 * decisiones de compra (cotizar, aprobar, adjudicar, pagar) quedan fuera.
 */
const RESIDENTE_RULES: Rule[] = [
  // Notificaciones push: cualquiera activa/desactiva las suyas
  { methods: "all", pattern: "push" },
  // Lectura: obra, presupuesto y precios unitarios
  { methods: "read", pattern: "proyectos" },
  { methods: "read", pattern: "proyectos/*" },
  { methods: "read", pattern: "presupuestos" },
  { methods: "read", pattern: "presupuestos/*" },
  { methods: "read", pattern: "presupuestos/*/*" },
  { methods: "read", pattern: "apus" },
  { methods: "read", pattern: "apus/*" },
  { methods: "read", pattern: "conceptos" },
  { methods: "read", pattern: "conceptos/*" },
  { methods: "read", pattern: "insumos" },
  { methods: "read", pattern: "insumos/*" },
  // Avance de obra (estimaciones, curvas y calendario): sólo lectura — parte
  // de la vista de obra que la página Obras enlaza.
  { methods: "read", pattern: "estimaciones" },
  { methods: "read", pattern: "estimaciones/*" },
  { methods: "read", pattern: "estimacion-curva-capitulo" },
  { methods: "read", pattern: "estimacion-curva-capitulo/*" },
  { methods: "read", pattern: "calendario-cierre-capitulo" },
  { methods: "read", pattern: "calendario-cierre-capitulo/*" },
  // Proveedores: ver el directorio y DAR DE ALTA nuevos desde la requisición
  // (edición de existentes y condiciones siguen siendo de admin: los PATCH/PUT
  // de suppliers/* y suppliers/*/terms no están listados).
  { methods: "all", pattern: "suppliers" },
  { methods: "read", pattern: "suppliers/*" },
  { methods: "read", pattern: "bitacora" },
  { methods: "read", pattern: "bitacora/*" },
  // Caja chica: ABRIR sus propios períodos, editarlos y subirles gastos —
  // el candado de dueño (creadaPorId) en las rutas impide tocar cajas
  // ajenas, y cambiar estado de revisión / cerrar (reembolsar) sigue siendo
  // de admin (guard en el PATCH; reembolsar es sub-acción de 3 segmentos
  // que no está listada).
  { methods: "all", pattern: "reembolsos" },
  { methods: "all", pattern: "reembolsos/*" },
  { methods: "all", pattern: "reembolsos/*/gastos" },
  // Conciliación de caja chica: sugerencias de CFDI para SU gasto y el
  // vínculo (la factura se marca amparando el gasto → deducible).
  { methods: "read", pattern: "gastos/*/cfdi-candidatos" },
  { methods: "all", pattern: "cfdis/*/vincular" },
  { methods: "all", pattern: "gastos" },
  { methods: "all", pattern: "gastos/*" },
  { methods: "read", pattern: "gastos/*/comprobante" },
  { methods: "read", pattern: "bank-accounts" },
  // Requisiciones: crear y editar las propias (borradores). Las sub-acciones
  // de decisión (cotizaciones/aprobar/adjudicaciones/pagar) NO están listadas
  // y por lo tanto quedan bloqueadas — `*` es un solo segmento.
  { methods: "all", pattern: "solicitudes-compra" },
  { methods: "all", pattern: "solicitudes-compra/*" },
];

/**
 * CONTABILIDAD: el escritorio de compras/pagos sin ser admin de obra.
 * Proveedores completos (directorio, alta, condiciones), COMPRAS (capturar
 * cotizaciones, adjudicar y autorizar requisiciones), PAGOS (cola de cuentas
 * por pagar: enviar a tesorería y pagar, incl. gastos aprobados) y
 * PRESUPUESTOS en sólo lectura. No crea requisiciones ni obras, no toca
 * destajo/caja chica/reportes/usuarios.
 */
const CONTABILIDAD_RULES: Rule[] = [
  // Notificaciones push: cualquiera activa/desactiva las suyas
  { methods: "all", pattern: "push" },
  // Contexto de obra y presupuesto (lectura)
  { methods: "read", pattern: "proyectos" },
  { methods: "read", pattern: "proyectos/*" },
  { methods: "read", pattern: "presupuestos" },
  { methods: "read", pattern: "presupuestos/*" },
  { methods: "read", pattern: "presupuestos/*/*" },
  { methods: "read", pattern: "apus" },
  { methods: "read", pattern: "apus/*" },
  { methods: "read", pattern: "conceptos" },
  { methods: "read", pattern: "conceptos/*" },
  { methods: "read", pattern: "insumos" },
  { methods: "read", pattern: "insumos/*" },
  // Avance de obra (estimaciones): sólo lectura, igual que presupuestos.
  { methods: "read", pattern: "estimaciones" },
  { methods: "read", pattern: "estimaciones/*" },
  { methods: "read", pattern: "estimacion-curva-capitulo" },
  { methods: "read", pattern: "estimacion-curva-capitulo/*" },
  { methods: "read", pattern: "calendario-cierre-capitulo" },
  { methods: "read", pattern: "calendario-cierre-capitulo/*" },
  // Proveedores: directorio completo, alta y condiciones (el import masivo
  // de CFDIs sigue siendo OWNER/ADMIN a nivel de ruta)
  { methods: "all", pattern: "suppliers" },
  { methods: "all", pattern: "suppliers/*" },
  { methods: "all", pattern: "suppliers/*/terms" },
  // Facturas y bancos: contexto de pago (lectura)
  { methods: "read", pattern: "cfdis" },
  { methods: "read", pattern: "cfdis/*" },
  { methods: "read", pattern: "bank-accounts" },
  { methods: "read", pattern: "bank-transactions" },
  // Gastos: operar su tramo de pagos (aprobar, enviar a tesorería, pagar)
  { methods: "read", pattern: "gastos" },
  { methods: "read", pattern: "gastos/*" },
  { methods: "read", pattern: "gastos/*/comprobante" },
  { methods: "all", pattern: "gastos/*/aprobar" },
  { methods: "all", pattern: "gastos/*/enviar-tesoreria" },
  { methods: "all", pattern: "gastos/*/aprobar-pagar" },
  // Conciliación de gastos con CFDI (deducibilidad)
  { methods: "read", pattern: "gastos/*/cfdi-candidatos" },
  { methods: "all", pattern: "cfdis/*/vincular" },
  // Compras: leer requisiciones y DECIDIR (cotizar, adjudicar, autorizar)
  { methods: "read", pattern: "solicitudes-compra" },
  { methods: "read", pattern: "solicitudes-compra/*" },
  { methods: "read", pattern: "solicitudes-compra/*/bt-candidates" },
  { methods: "all", pattern: "solicitudes-compra/*/cotizaciones" },
  { methods: "all", pattern: "solicitudes-compra/*/adjudicaciones" },
  { methods: "all", pattern: "solicitudes-compra/*/aprobar" },
  { methods: "all", pattern: "solicitudes-compra/*/pagar" },
  { methods: "all", pattern: "solicitudes-compra/*/vincular-bt" },
  // Pagos: la cola de cuentas por pagar completa
  { methods: "all", pattern: "cuentas-por-pagar" },
  { methods: "all", pattern: "cuentas-por-pagar/*" },
  { methods: "all", pattern: "pagos-proveedor" },
  { methods: "all", pattern: "pagos-proveedor/*" },
  { methods: "all", pattern: "adjudicaciones" },
  { methods: "all", pattern: "adjudicaciones/*" },
];

const RULES: Partial<Record<ConstruccionRol, Rule[]>> = {
  TESORERIA: TESORERIA_RULES,
  RESIDENTE: RESIDENTE_RULES,
  CONTABILIDAD: CONTABILIDAD_RULES,
};

/**
 * Facultades por PÁGINA de bartiz, para los grants de la matriz de permisos
 * (CompanyMember.construccionPaginas). Cada llave es una página del satélite
 * y su bundle son los endpoints que esa página necesita para FUNCIONAR (lo
 * que un admin puede hacer parado en ella).
 *
 * Un bundle sólo aplica cuando la página está marcada Y queda FUERA del
 * alcance natural del rol (ROL_PAGINAS): dentro del alcance, las facultades
 * exactas del rol mandan y la matriz sólo recorta visibilidad — así marcar
 * la caja chica de un residente no le regala de pronto cerrar períodos.
 *
 * "usuarios" no tiene bundle a propósito: esa ruta exige OWNER/ADMIN de
 * plataforma y un grant no debe poder abrirla.
 */
const PAGINA_RULES: Record<string, Rule[]> = {
  obras: [
    { methods: "read", pattern: "proyectos" },
    { methods: "read", pattern: "proyectos/*" },
    { methods: "read", pattern: "presupuestos" },
    { methods: "read", pattern: "presupuestos/*" },
    { methods: "read", pattern: "presupuestos/*/*" },
    { methods: "read", pattern: "estimaciones" },
    { methods: "read", pattern: "estimaciones/*" },
    { methods: "read", pattern: "estimacion-curva-capitulo" },
    { methods: "read", pattern: "estimacion-curva-capitulo/*" },
    { methods: "read", pattern: "calendario-cierre-capitulo" },
    { methods: "read", pattern: "calendario-cierre-capitulo/*" },
    { methods: "read", pattern: "apus" },
    { methods: "read", pattern: "apus/*" },
    { methods: "read", pattern: "conceptos" },
    { methods: "read", pattern: "conceptos/*" },
    { methods: "read", pattern: "insumos" },
    { methods: "read", pattern: "insumos/*" },
    { methods: "read", pattern: "bitacora" },
    { methods: "read", pattern: "bitacora/*" },
  ],
  requisiciones: [
    { methods: "all", pattern: "solicitudes-compra" },
    { methods: "all", pattern: "solicitudes-compra/*" },
    { methods: "all", pattern: "suppliers" },
    { methods: "read", pattern: "suppliers/*" },
    { methods: "read", pattern: "proyectos" },
    { methods: "read", pattern: "proyectos/*" },
    { methods: "read", pattern: "presupuestos" },
    { methods: "read", pattern: "presupuestos/*" },
    { methods: "read", pattern: "presupuestos/*/*" },
    { methods: "read", pattern: "insumos" },
    { methods: "read", pattern: "insumos/*" },
  ],
  compras: [
    { methods: "read", pattern: "solicitudes-compra" },
    { methods: "read", pattern: "solicitudes-compra/*" },
    { methods: "read", pattern: "solicitudes-compra/*/bt-candidates" },
    { methods: "all", pattern: "solicitudes-compra/*/cotizaciones" },
    { methods: "all", pattern: "solicitudes-compra/*/adjudicaciones" },
    { methods: "all", pattern: "solicitudes-compra/*/aprobar" },
    { methods: "read", pattern: "suppliers" },
    { methods: "read", pattern: "suppliers/*" },
    { methods: "read", pattern: "proyectos" },
    { methods: "read", pattern: "proyectos/*" },
    { methods: "read", pattern: "cfdis" },
    { methods: "read", pattern: "cfdis/*" },
    { methods: "read", pattern: "insumos" },
    { methods: "read", pattern: "insumos/*" },
  ],
  pagos: [
    { methods: "all", pattern: "cuentas-por-pagar" },
    { methods: "all", pattern: "cuentas-por-pagar/*" },
    { methods: "all", pattern: "pagos-proveedor" },
    { methods: "all", pattern: "pagos-proveedor/*" },
    { methods: "all", pattern: "adjudicaciones" },
    { methods: "all", pattern: "adjudicaciones/*" },
    { methods: "all", pattern: "adjudicaciones/*/enviar-tesoreria" },
    { methods: "all", pattern: "solicitudes-compra/*/pagar" },
    { methods: "all", pattern: "solicitudes-compra/*/vincular-bt" },
    { methods: "all", pattern: "gastos/*/enviar-tesoreria" },
    { methods: "all", pattern: "gastos/*/aprobar-pagar" },
    { methods: "read", pattern: "solicitudes-compra" },
    { methods: "read", pattern: "solicitudes-compra/*" },
    { methods: "read", pattern: "gastos" },
    { methods: "read", pattern: "gastos/*" },
    { methods: "read", pattern: "gastos/*/comprobante" },
    { methods: "read", pattern: "suppliers" },
    { methods: "read", pattern: "suppliers/*" },
    { methods: "read", pattern: "cfdis" },
    { methods: "read", pattern: "cfdis/*" },
    { methods: "read", pattern: "bank-accounts" },
    { methods: "read", pattern: "bank-transactions" },
    { methods: "read", pattern: "proyectos" },
    { methods: "read", pattern: "proyectos/*" },
  ],
  bancos: [
    { methods: "read", pattern: "bank-accounts" },
    { methods: "all", pattern: "bank-transactions" },
    { methods: "all", pattern: "bank-transactions/*" },
    { methods: "all", pattern: "bank-transactions/*/conciliar" },
    { methods: "all", pattern: "bank-transactions/*/desconciliar" },
    { methods: "read", pattern: "bank-transactions/*/cfdi-candidatos" },
    { methods: "read", pattern: "cfdis" },
    { methods: "read", pattern: "cfdis/*" },
    { methods: "read", pattern: "suppliers" },
    { methods: "read", pattern: "suppliers/*" },
    { methods: "read", pattern: "proyectos" },
  ],
  facturas: [
    { methods: "read", pattern: "cfdis" },
    { methods: "read", pattern: "cfdis/*" },
    { methods: "all", pattern: "cfdis/*/vincular" },
    { methods: "all", pattern: "cfdis/*/ignorar" },
    { methods: "read", pattern: "cfdis/*/candidatos" },
    { methods: "read", pattern: "suppliers" },
    { methods: "read", pattern: "suppliers/*" },
    { methods: "read", pattern: "solicitudes-compra" },
    { methods: "read", pattern: "solicitudes-compra/*" },
    { methods: "read", pattern: "gastos" },
    { methods: "read", pattern: "gastos/*" },
  ],
  gastos: [
    { methods: "all", pattern: "gastos" },
    { methods: "all", pattern: "gastos/*" },
    { methods: "all", pattern: "gastos/*/aprobar" },
    { methods: "all", pattern: "gastos/*/enviar-tesoreria" },
    { methods: "all", pattern: "gastos/*/aprobar-pagar" },
    { methods: "read", pattern: "gastos/*/comprobante" },
    { methods: "read", pattern: "suppliers" },
    { methods: "read", pattern: "suppliers/*" },
    { methods: "read", pattern: "proyectos" },
    { methods: "read", pattern: "proyectos/*" },
    { methods: "read", pattern: "bank-accounts" },
    { methods: "read", pattern: "insumos" },
    { methods: "read", pattern: "insumos/*" },
    { methods: "read", pattern: "presupuestos" },
    { methods: "read", pattern: "presupuestos/*" },
  ],
  caja: [
    { methods: "all", pattern: "reembolsos" },
    { methods: "all", pattern: "reembolsos/*" },
    { methods: "all", pattern: "reembolsos/*/gastos" },
    { methods: "all", pattern: "reembolsos/*/reembolsar" },
    { methods: "all", pattern: "gastos" },
    { methods: "all", pattern: "gastos/*" },
    { methods: "read", pattern: "gastos/*/comprobante" },
    { methods: "read", pattern: "proyectos" },
    { methods: "read", pattern: "proyectos/*" },
    { methods: "read", pattern: "bank-accounts" },
    { methods: "read", pattern: "bank-transactions" },
    { methods: "read", pattern: "suppliers" },
    { methods: "read", pattern: "suppliers/*" },
  ],
  destajo: [
    { methods: "all", pattern: "rayas" },
    { methods: "all", pattern: "rayas/*" },
    { methods: "all", pattern: "rayas/*/aprobar" },
    { methods: "all", pattern: "rayas/*/pagar" },
    { methods: "all", pattern: "cuadrillas" },
    { methods: "all", pattern: "cuadrillas/*" },
    { methods: "all", pattern: "cuadrillas/*/miembros" },
    { methods: "all", pattern: "cuadrillas/*/miembros/*" },
    { methods: "read", pattern: "proyectos" },
    { methods: "read", pattern: "proyectos/*" },
    { methods: "read", pattern: "bank-accounts" },
    { methods: "read", pattern: "bank-transactions" },
  ],
  proveedores: [
    { methods: "all", pattern: "suppliers" },
    { methods: "all", pattern: "suppliers/*" },
    { methods: "all", pattern: "suppliers/*/terms" },
    { methods: "read", pattern: "cfdis" },
    { methods: "read", pattern: "cfdis/*" },
    { methods: "read", pattern: "pagos-proveedor" },
    { methods: "read", pattern: "pagos-proveedor/*" },
    { methods: "read", pattern: "adjudicaciones" },
    { methods: "read", pattern: "adjudicaciones/*" },
  ],
  "edos-prov": [
    { methods: "read", pattern: "suppliers" },
    { methods: "read", pattern: "suppliers/*" },
    { methods: "read", pattern: "pagos-proveedor" },
    { methods: "read", pattern: "pagos-proveedor/*" },
    { methods: "read", pattern: "adjudicaciones" },
    { methods: "read", pattern: "adjudicaciones/*" },
    { methods: "read", pattern: "cfdis" },
    { methods: "read", pattern: "cfdis/*" },
  ],
  catalogo: [
    { methods: "all", pattern: "conceptos" },
    { methods: "all", pattern: "conceptos/*" },
    { methods: "all", pattern: "insumos" },
    { methods: "all", pattern: "insumos/*" },
    { methods: "all", pattern: "apus" },
    { methods: "all", pattern: "apus/*" },
    { methods: "read", pattern: "presupuestos" },
    { methods: "read", pattern: "presupuestos/*" },
  ],
  reportes: [
    { methods: "read", pattern: "reportes" },
    { methods: "read", pattern: "reportes/*" },
    { methods: "read", pattern: "proyectos" },
    { methods: "read", pattern: "proyectos/*" },
    { methods: "read", pattern: "presupuestos" },
    { methods: "read", pattern: "presupuestos/*" },
    { methods: "read", pattern: "gastos" },
    { methods: "read", pattern: "solicitudes-compra" },
    { methods: "read", pattern: "estimaciones" },
    { methods: "read", pattern: "rayas" },
  ],
};

/**
 * Alcance NATURAL de páginas por rol — espejo de la navegación de bartiz
 * (roles.js paginasDelRol). Dentro de este alcance las facultades del ROL
 * mandan y los bundles NO aplican; fuera, una página marcada en la matriz
 * es un grant y su bundle amplía el allowlist.
 */
const ROL_PAGINAS: Partial<Record<ConstruccionRol, string[]>> = {
  TESORERIA: ["pagos"],
  RESIDENTE: ["obras", "requisiciones", "caja", "proveedores", "gastos"],
  CONTABILIDAD: ["compras", "pagos", "requisiciones", "proveedores", "edos-prov", "obras"],
};

function matches(pattern: string, path: string): boolean {
  const p = pattern.split("/");
  const s = path.split("/");
  if (p.length !== s.length) return false;
  return p.every((seg, i) => seg === "*" || seg === s[i]);
}

/**
 * Lanza AuthzError(403) si ni el rol de construcción ni los grants de la
 * matriz de páginas permiten (método, ruta). Sólo aplica a
 * /api/construccion/*; cualquier otra ruta pasa intacta (p. ej. /api/auth/*
 * para cambiar contraseña).
 *
 * `paginas` = CompanyMember.construccionPaginas. Las páginas marcadas FUERA
 * del alcance natural del rol amplían el allowlist con su bundle
 * (PAGINA_RULES); las de dentro no cambian nada aquí — son recorte de
 * visibilidad que la UI aplica sola.
 */
export function enforceConstruccionRol(
  rol: ConstruccionRol,
  req: Request,
  paginas: string[] = []
): void {
  const rules = RULES[rol];
  if (!rules) return; // ADMIN u otro rol futuro sin tabla = sin restricción

  const url = new URL(req.url);
  const m = url.pathname.match(/^\/api\/construccion\/(.+?)\/?$/);
  if (!m) return; // fuera del satélite de construcción no restringimos

  const path = m[1];
  const isRead = READ_METHODS.has(req.method.toUpperCase());
  const permite = (rs: Rule[]) =>
    rs.some(
      (r) =>
        (r.methods === "all" || (r.methods === "read" && isRead)) &&
        matches(r.pattern, path)
    );

  if (permite(rules)) return;

  // Grants de la matriz: sólo páginas fuera del alcance natural del rol.
  const alcance = ROL_PAGINAS[rol] ?? [];
  for (const p of paginas) {
    if (alcance.includes(p)) continue;
    const bundle = PAGINA_RULES[p];
    if (bundle && permite(bundle)) return;
  }

  throw new AuthzError(
    403,
    "Tu rol en construcción no permite esta operación"
  );
}
