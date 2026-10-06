# BARTIZ — datos de construcción y estado de resultados por obra

Empresa: CONSTRUCTORA BARTIZ-VERT (CBA170606FQ8). Satélite: repo `bartiz`
(React SPA) contra `/api/construccion/*` de este hub.

## Estado al 2 de octubre de 2026

**Proyectos (6):** OBR-HACIENDA-OVINOS (en ejecución, presupuesto aprobado +
ejecutado), UDLAP001/002/003, MITLA001 (gobierno, Oaxaca) y TALLER001
(techumbre Leapmotor). Los cinco presupuestos nuevos siguen en BORRADOR; ningún
proyecto tiene cliente, fechas, programa, unidades ni estimaciones.

**Requisiciones:** 136 capturadas del 22-sep al 2-oct en TALLER001 y MITLA001
desde el formulario de bartiz, que tenía las columnas Cantidad/Unidad
desalineadas (bartiz PR #69 lo corrige). Quedaron con el precio en `cantidad`
y la cantidad en el `precioUnitario` de la única cotización, en estado
PENDIENTE y sin adjudicar: no contaban como costo del proyecto. Son en su
mayoría comprobaciones de gasto ya pagadas (gasolina, peajes, materiales,
destajistas), no concursos.

**CFDIs:** 14 CFDIs de ingreso vigentes en 2026 (5 cancelados explican los
pares duplicados) y 222 de egreso; ninguno estaba vinculado a un proyecto.

## Reparación: `scripts/bartiz-reparar-requisiciones.ts`

Dry-run por defecto; `--aplicar` escribe; `--hasta=<ISO>` acota por fecha de
captura (usar la hora del deploy de bartiz PR #69 si el residente siguió
capturando con el formulario viejo).

```
DATABASE_URL=… npx tsx scripts/bartiz-reparar-requisiciones.ts --fase=todo --aplicar
```

Fases, en este orden:

1. **proveedores** — unifica variantes del mismo nombre (cuatro formas de
   «José Alfredo Itzcoatl Chantes», etc.), da de alta `Supplier` con el RFC
   del CFDI que empata con la requisición (LAMONT = Roberto Montemayor,
   Chubb, Charrito, Home Depot…) y liga `supplierId`. Lista los nombres que
   siguen sin RFC.
2. **swap** — intercambia cantidad ↔ precio salvo las líneas que sí venían
   bien (rollos LAMONT, lámina TEPSA) y combustible con litros de bomba
   (3 decimales). Separa «8 PZA» en cantidad + unidad. Fija `ivaTasa`:
   - **La cifra capturada es el total pagado.** Se verificó contra los
     CFDIs: LAMONT 238,950, Chubb 11,730.31, FC Materiales 14,344.22, Magno
     23,775… coinciden con el *total* del CFDI aunque la nota diga «el
     precio es sin IVA».
   - Proveedor formal (Supplier con RFC, CFDI empatado, S.A./S. de R.L.)
     ⇒ precio ÷ 1.16 y tasa 16 %. Informal (personas, peajes, gasolina,
     taxis, OXXO) ⇒ sin IVA. En ambos casos **pagable = capturado**; nunca
     se agrega IVA encima.
3. **cerrar** — selecciona la única cotización, aprueba (adjudicaciones con
   desglose de IVA vía `generateAdjudicaciones`) y registra el pago por el
   total con fecha de captura (`aplicarPago`) ⇒ PAGADA. El proyecto las ve
   en `comprometido` y `pagadoReal` de `/proyectos/:id/costos`.
4. **cfdis** — vincula CFDIs de egreso STAMPED con la requisición de igual
   total (o varios del mismo RFC y día que suman) en
   `construccion_cfdi_vinculo` ⇒ `facturado` del proyecto.

El libro local `scripts/.bartiz-reparacion.json` (ignorado por git) evita
repetir el swap. Tras cerrar, las requisiciones ya no son PENDIENTE, así que
una segunda corrida sólo toca lo nuevo.

## Ingresos por obra: `scripts/bartiz-ingresos.ts`

Dry-run por defecto; `--aplicar` escribe.

1. **cancelados** — consulta el SAT (ConsultaCFDI) por cada CFDI de ingreso
   STAMPED de 2026 y marca CANCELLED los cancelados (IOCIFED 8A97CBC4,
   cancelado el 17-sep; el sync del SAT no lo había reflejado).
2. **proyectos** — crea BOMBEROS-2025 (Municipio de Cuautlancingo, el
   depósito de abril es el finiquito) y UDLAP-CMAT-2025 (el pago de marzo
   es de CMAT), TERMINADOS, con presupuesto de contrato = lo cobrado; liga
   el cliente de UDLAP001/2/3 (UDLAP) y MITLA001 (INIFED).
3. **estimaciones** — una Estimación TIMBRADA por CFDI del mapa
   `ESTIMACION_POR_CFDI` (subtotal/IVA/total del CFDI, periodo = mes,
   `invoiceId`). MITLA no tiene anticipo: el CFDI vigente a INIFED es la
   estimación 1. No asienta en el libro: el CFDI ya es ingreso fiscal; la
   estimación es la atribución a la obra.

Sin proyecto todavía (agregar al mapa cuando el usuario diga la obra):
Altiplano (658k abr + 187k jul), Parque del Rey (500k may), Andaluces
(500k ago + 1M sep), UDLAP 75,218.59 (mar), Público en general 3,500.

## Estado de resultados por obra

`GET /api/construccion/reportes/estado-resultados?companyId=…[&proyectoId=…]`
— acumulado a la fecha, sin IVA: ingresos facturados (estimaciones con
CFDI) y cobrados, contrato y presupuesto, costos (compras adjudicadas,
gastos directos/indirectos, destajo), utilidad bruta y margen; totales de la
empresa. Las adjudicaciones legadas sin desglose de IVA entran por su total
y se cuentan en `comprasSinDesglose`. La página de Reportes vive en bartiz.

## Pendiente

- Datos maestros (usuario): fechas, contrato/licitación/modalidad/retención
  de MITLA001, `aplicaIva` de UDLAP, aprobar los presupuestos BORRADOR.
- Obras de Altiplano, Parque del Rey y Andaluces: crear el proyecto y
  mapear sus CFDIs.
- Rayas (destajo) y gastos de obra siguen sin capturarse en Bartiz: el
  costo de mano de obra no está en el P&L.
- Nombres sin RFC que conviene dar de alta cuando llegue su CFDI: TEPSA,
  Materiales para Construcción San Francisco, LIAGTSA, SOFIMEX, Lámina
  Corte Doblez.
