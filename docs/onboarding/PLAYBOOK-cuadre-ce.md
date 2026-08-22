# Playbook: cuadrar el libro derivado contra la CE presentada

Cómo llevar una empresa nueva desde «tenemos sus CFDIs» hasta «el estado de
resultados derivado cuadra con lo que declaró al SAT». Es la receta que en
MARGOM llevó la divergencia del grupo 4 de **$1,288.5M a $45.2M** y el costo+gasto
combinado a **0.09%** (era propia, 2024-10 → 2026-06).

## Lo que ya NO hay que rehacer — el motor es genérico

Estas reglas viven en `posting.ts` + sus módulos y aplican a CUALQUIER empresa
sin tocar código, en cuanto el catálogo y las reglas de la empresa existan:

- **Nota de crédito espejo** (`nota-credito.ts`): el comprobante de egreso (E)
  invierte el asiento; la aplicación de anticipo deja de contarse doble.
- **Familia** (`resolver-familia.ts`): venta de unidad NUEVA → 4101/5101/1301.
- **CxC por módulo** (`cxc-cxp-modulo.ts`): unidades/refacciones/servicio.
- **Taller** (`taller.ts`): mano de obra → 4301, refacciones → 4401, su costo
  por la compra → 5401.
- **Intercambio** (`intercambio.ts`): venta al costo (margen ~0) → 4131/5131.
- **Plan propio** (`resolver-plan-propio.ts`): override > serie única > fallback.
- **Regla de serie** (`serie-cuenta.ts`): `serie:XXX` en overrides como fallback.

## Lo que SÍ es por-empresa — la configuración de cada alta

El motor es genérico, pero necesita, por empresa: su catálogo, su numeración por
familia, sus overrides de agrupadores gigantes, sus reglas de serie, y su piso
ligado. Ese es el trabajo de un onboarding.

---

## Los pasos, en orden

Cada script `*-margom.ts` es la plantilla; para otra empresa se copia cambiando
el `COMPANY`/RFC (pendiente: parametrizarlos por `--company`). Todos son
**dry-run por default; APPLY=1 escribe**. Las escrituras las corre el usuario.

### Fase A — Datos: la verdad y la materia prima

1. **FIEL** cargada y cifrada (onboarding de la empresa). Sin ella no hay
   descarga masiva ni portal.
2. **Archivo de CFDIs** completo por descarga masiva del SAT (emitidas +
   recibidas vigentes). Ojo con los tramos y la cuota 5002 (ver
   `docs/HANDOFF-inventario-cfdis.md`, trampas de medición).
3. **Balanzas CE** importadas a `CeBalanzaMes` — ES LA VERDAD contra la que se
   cuadra. Hoy vía `importar-serie-ce-margom.ts` (Syntage); el camino portal-SAT
   está en construcción (`src/lib/sat-portal/`, `docs/sat-portal-captura.md`).
   **Sin CE importada, no hay contra qué comparar — este paso es la piedra
   angular, no un extra.**

### Fase B — Catálogo e inventario

4. **Importar el catálogo del contador** (`import-ce`) → `ChartAccount` con
   `codAgrup`. Es SU plan de cuentas; el motor postea a estas cuentas.
5. **`backfill-codagrup-series-margom.ts`** — infiere `codAgrup` para cuentas de
   familia huérfanas (una familia que el CT no trae pero el ERP sí). Por
   unanimidad de serie.
6. **Reconstruir el piso**: `reconstruir-ciclos-margom.ts` (unidad que reentra) +
   `ligar-ventas-huerfanas-margom.ts` (liga unidad→venta cuando el VIN no está
   en el XML: por número de motor, texto, o refactura). Cada unidad ligada es un
   costo que sale de 1301 y un ingreso que resuelve familia.

### Fase C — Decisiones de la empresa (con evidencia, no a ciegas)

7. **Familias por marca** — `familia-vehiculo.ts` trae las 28 de MARGOM
   HARDCODEADAS. Otra agencia con otras marcas necesita SUS familias aquí.
   **Es la única pieza por-empresa que hoy vive en código, no en datos** —
   pendiente de mover a config por empresa.
8. **Overrides de agrupadores gigantes** (`override-proveedores-margom.ts` es el
   patrón): un agrupador que el motor no desambigua (p.ej. 201.01 → CXP PLANTA
   VEHÍCULOS). Se propone con evidencia (dry-run mide cuánto dinero re-postea)
   antes de aplicar.
9. **Reglas de serie** (`reglas-serie-margom.ts`): el back-end que ningún
   documento clasifica solo (comisiones, GAP/UDIS → 4501; seminuevos → 4291).
   Se lee la serie del folio del DMS. Dry-run mide % contra la CE antes de
   escribir. En MARGOM: `serie:NCA`→4501 y `serie:SM`→4291, ambas al 100.9%.

### Fase D — Aplicar y verificar

10. **Re-postear** (`repostear-margom.ts`, `DESDE=<primer período> APPLY=1`):
    postMonth es idempotente — regenera CFDI/NÓMINA/BANCO/DEPRECIACIÓN y
    preserva MANUAL/APERTURA. Es la migración: cambiadas las reglas, re-postear
    la historia las aplica. Correr detached (nohup), ~1 tx por período.
11. **Verificar** (`verificar-divergencia-margom.ts`): el checksum. Tres cortes —
    grupos 4/5/6 derivado vs CE, cuentas de taller/fallback, e ingreso posteado
    de CFDIs CANCELADOS (debe ser $0). Repetir hasta que el resultado cuadre.

## La meta, y cómo se ve «cuadrado»

- **Ingreso (grupo 4)** derivado vs CE: dentro de ~1% del ingreso.
- **Costo+gasto (grupos 5+6) COMBINADO**: <1% (en MARGOM, 0.09%). Se miden
  juntos porque el motor y el contador parten el mismo peso distinto entre costo
  y gasto — netea.
- **Ingreso de CFDIs cancelados: $0** (postMonth sólo lee STAMPED; si no es cero,
  falta re-postear tras conocerse las cancelaciones).
- **Comparar sólo la ERA PROPIA** (desde que el CT propio existe; en MARGOM
  2024-10). Antes de eso es era agrupador — medir contra cuentas que no existían
  es medir contra ruido.

## Lo que NO cierra sin bancos (y no es falla del pipeline)

CxC/CxP/IVA en flujo (grupos 1/2 y el IVA) necesitan movimientos bancarios: un
CFDI dice que nació el derecho, no que se cobró. Eso es fase de conciliación, no
de este cuadre. El estado de resultados SÍ cuadra sin bancos; el balance no.

## Huecos conocidos al cierre de MARGOM (referencia para la próxima)

- **5291 costo de seminuevos**: $0 derivado vs lo declarado — `unidadesAmparadas`
  filtra `tipo:"NUEVO"`, así que el usado resuelve su venta (regla de serie) pero
  no su costo. Arreglo de una condición en el resolver de familia.
- **Reparto DENTRO de la serie**: `serie:NCA` cae todo en 4501-genérico aunque el
  contador lo abra en comisión/UDIS/garantías; el total cuadra, el fino es su
  decisión.
- **Departamento del gasto 6xx**: el concepto se deriva, el departamento no lo
  dice el CFDI (necesita input del contador).
