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

## Pendiente para el estado de resultados por obra

- **Datos maestros** (el usuario los provee): cliente de cada proyecto,
  fechas, contrato/licitación/dependencia/anticipo/retención de MITLA001,
  `aplicaIva` de las obras UDLAP, aprobar los presupuestos BORRADOR.
- **Proyectos faltantes** para clientes ya facturados: Conjunto Residencial
  del Altiplano (658k + 187k), Municipio de Cuautlancingo (859k, ¿Hacienda
  Ovinos?), Inmobiliaria Parque del Rey (500k), Bienes Inmuebles Andaluces
  (500k + 1M), UDLAP de marzo (426k + 75k). IOCIFED y INIFED tienen un CFDI
  de 2,636,761.91 cada uno: confirmar cuál es el anticipo de MITLA001.
- **Ingresos por obra:** el vínculo de CFDI sólo apunta a SOLICITUD / GASTO
  / ESTIMACION / BANK_TX, así que cada CFDI de ingreso se ata al proyecto
  creando su `Estimacion` (numero, periodo, subtotal/iva/total, `invoiceId`).
- **Endpoint** `GET /api/construccion/proyectos/:id/estado-resultados`:
  ingresos (estimaciones con CFDI, sin IVA) − costos (`comprometido` sin
  IVA + rayas + gastos) = utilidad bruta por obra; la página de Reportes la
  hace el equipo de UI de bartiz.
- Nombres sin RFC que conviene dar de alta cuando llegue su CFDI: TEPSA,
  Materiales para Construcción San Francisco, LIAGTSA, SOFIMEX, Lámina
  Corte Doblez.
