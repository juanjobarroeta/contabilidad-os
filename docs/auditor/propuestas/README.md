# Propuestas — checks diarios del auditor, por régimen

Qué revisaría **a diario** un contador real para cada régimen fiscal, expresado como
checks automatizables que extienden el framework de auditoría existente
(`src/lib/fiscal/audit/` → `runAuditForCompany` → `FiscalHallazgo`, corrido por el
cron `fiscal-audit` y resumido en `revision-digest`).

> Borradores de diseño (no código). Cada check se modela como un `evaluar(...): Hallazgo[]`
> puro + un cargador de datos, gated por `aplicabilidad` (régimen/tipoPersona/sector),
> persistido idempotentemente por `dedupeKey` — el mismo patrón que `duplicados`,
> `rep-fecha-pago`, `pue-pagos`, `banco-movimientos`, `declaraciones-faltantes`.

## Documentos
| Régimen | Archivo | Perfil |
|---|---|---|
| 601 PM Régimen General | [`601-pm-general.md`](./601-pm-general.md) | Constructoras / servicios / SAPIs |
| 612 PF Actividad Empresarial y Profesional | [`612-pf-actividad-empresarial.md`](./612-pf-actividad-empresarial.md) | Profesionistas / pequeños operadores |
| 626 RESICO (PF y PM) | [`626-resico.md`](./626-resico.md) | Riesgo de **expulsión** del régimen |
| 606 Arrendamiento · 625 Plataformas | [`606-arrendamiento-625-plataformas.md`](./606-arrendamiento-625-plataformas.md) | Arrendadores · repartidores/hosts (Art. 113-A) |
| Nómina / patrón (605 + obligaciones patronales) | [`605-nomina-patron.md`](./605-nomina-patron.md) | IMSS / INFONAVIT / ISR retenido |

## Síntesis cross-régimen — qué construir primero

**Checks que aplican a casi todos y son automatizables HOY** (mayor ROI, empezar por aquí):
- **CSD / e.firma por vencer** (`csd.por_vencer` / `fiel.por_vencer`) — `Company.csdVigencia`/`fielVigencia`. Previene paro de timbrado y de declaraciones. Trivial, alto impacto.
- **Opinión 32-D negativa / régimen-estatus** — ya casi cableado: `compliance-sync` → `diff.ts` emite `cumplimiento.sat_opinion.negativa`. Falta enriquecer el mensaje (p.ej. enmarcarlo como expulsión de RESICO).
- **PPD de ingreso cobrado sin REP** (`cfdi.ppd.sin_rep`) — gated por conciliación bancaria para no hacer ruido. Recurre en 601 y 612.
- **Depósito en banco sin CFDI de ingreso** (`banco.ingreso_no_facturado`) — `BankTransaction(CREDITO, UNMATCHED)` sin factura. Posible ingreso no facturado / mezcla personal.
- **Obligación del periodo en curso próxima a vencer** — complementa el check histórico `declaraciones.faltantes` mirando hacia adelante (día 17).
- **RESICO: ingresos acumulados vs límite** (3.5M PF / 35M PM) — construible hoy con agregado de `Invoice` + `detectResicoKind` (`src/lib/resico.ts`), severidad escalando 80/90/100%.

**Específicos de alto valor:**
- 626: retención 1.25% de clientes PM, factura global mensual a público (`XAXX010101000`).
- Nómina: CFDI de nómina sin transferencia bancaria conciliada; empleado con CFDI pero posible no-alta IMSS; SDI desactualizado; ISR vs tarifa Art. 96.
- 612: deducción **personal** (uso D01–D10) colada como gasto del negocio.
- 625: actividad de plataforma no definida (`plat.actividad_no_definida`, espeja el flag `asumida`).

## Gaps de datos a resolver (bloquean ciertos checks)
Recurrentes en los cinco documentos — vale la pena priorizarlos porque desbloquean varios checks a la vez:
- **`CfdiNormalizado` no expone** `usoCfdi`, retenciones, ni `customer.rfc` → bloquea deducción-personal, retenciones PM, factura global.
- **`Invoice` no tiene emisor** (solo `customer`/receptor) → el RFC de plataforma (625) no tiene identidad limpia; falta un **catálogo de RFCs de plataformas**.
- **Sin marca de "factura global"** → no se detecta su omisión mensual (RESICO).
- **Umbrales/tasas como constantes**, no en la capa `rules` (`getRule`) — el catálogo (límites RESICO, tope efectivo Art. 27/112, Art. 151) debería versionarse ahí.
- **Nómina:** `ImssMovimiento` es captura interna **sin integración IDSE**, sin calendario de días hábiles, sin historial de SBC ni prima de riesgo → altas/bajas solo **parcialmente** verificables.
- **606:** no hay modelo de contrato/inmueble → "renta no facturada" no es detectable aún.
- **"Cobrado" real** (flujo) requiere `PagoDoctoRelacionado`/conciliación, no solo el CFDI.

## Siguiente paso sugerido
Implementar como primer lote los 4–5 checks "automatizables hoy + cross-régimen" de arriba
(reusando el patrón existente), y en paralelo abrir el trabajo de datos para exponer
`usoCfdi`/retenciones/`customer.rfc` en `CfdiNormalizado` (desbloquea el segundo lote).
