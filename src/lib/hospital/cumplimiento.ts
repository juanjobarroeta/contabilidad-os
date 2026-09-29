/** Evidence requirements, not a declaration of legal conformity. Applicability needs facility review. */
export const OBLIGACIONES = [
  ["LICENCIA", "Licencia sanitaria por sede y servicios", "Operaciones", "Licencia, domicilio autorizado, servicios y evidencia de exhibición"],
  ["AVISO", "Aviso de funcionamiento", "Operaciones", "Acuse, fecha de inicio y responsable con cédula; justificar aplicabilidad"],
  ["PERSONAL", "Archivo profesional y privilegios", "Dirección médica", "Títulos, cédulas verificadas, vigencias y alcance autorizado por persona"],
  ["RESPONSABLE", "Responsable sanitario y cambios", "Operaciones", "Nombramiento, cédula, baja y acuses de sustitución con fechas límite"],
  ["EXPEDIENTE", "Expediente, conservación y recuperación", "Archivo clínico", "Política desde último acto médico, retenciones legales, prueba de restauración y responsables"],
  ["RESUMEN", "Solicitud y entrega de resumen clínico", "Archivo clínico", "Solicitante y representación, diagnóstico, evolución, tratamiento, pronóstico y acuse de entrega"],
  ["REGISTROS", "Registros diarios y servicios auxiliares", "Dirección médica", "Registro diario, resultados, validación y trazabilidad de actividad"],
  ["CONSENTIMIENTOS", "Ingreso y consentimiento por procedimiento", "Dirección médica", "Documento vigente, información de riesgos, firmas, capacidad y representación; excepción documentada"],
  ["PALIATIVOS", "Paliativos y voluntad anticipada", "Dirección médica", "Instrucción escrita, capacidad, plan y decisiones de urgencia/comité cuando aplique"],
  ["TRASPLANTES", "Donación y trasplantes", "Dirección médica", "Aplicabilidad por servicio; autorización y consentimiento específico con revisión profesional"],
  ["PRIVACIDAD", "Datos sensibles, avisos y derechos", "Privacidad", "Avisos integral/simplificado, finalidades, base jurídica, consentimientos/excepciones, revocación y ARCO"],
  ["RPBI", "Gestión de RPBI", "Operaciones", "Clasificación, envasado, almacenamiento, pesaje, recolección, manifiestos y disposición"],
  ["NOM024", "Interoperabilidad y evaluación de conformidad", "Sistemas", "Identificadores registrados, pruebas con receptor y evaluación externa aplicable"],
  ["FARMACIA", "Apertura y conciliación de farmacia", "Farmacia", "Conteo físico, lotes/caducidad, mínimos, cadena de frío y cuarentena"],
  ["PROTOCOLOS", "Protocolos de servicios autorizados", "Dirección médica", "Versión aprobada, usuarios capacitados y prueba del flujo clínico"],
  ["FINANZAS", "Ciclo financiero y contable", "Finanzas", "Convenios revisados, emisores/pagadores, facturas, depósitos, cancelaciones, banco y mayor conciliados"],
  ["CONTINUIDAD", "Continuidad operativa", "Sistemas", "Respaldos, restauración, tiempos de recuperación, operación durante caída y simulacro"],
  ["ACTIVOS", "Activos y mantenimiento preventivo", "Operaciones", "Inventario físico, programa, responsables, tickets y evidencia de ejecución"],
] as const;
export function estadoObligacion(datos: Record<string, unknown> | undefined, hoy = new Date()) {
  if (!datos) return "SIN_EVIDENCIA";
  if (datos.estado === "VERIFICADO" && typeof datos.vence === "string" && new Date(`${datos.vence}T23:59:59-06:00`) < hoy) return "VENCIDO";
  if (datos.estado === "VERIFICADO" && typeof datos.siguienteRevision === "string" && new Date(`${datos.siguienteRevision}T23:59:59-06:00`) < hoy) return "REVISION_PENDIENTE";
  return datos.estado;
}
