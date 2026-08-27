# Arquitectura — EHABSA (vertical de planta purificadora)

> Extiende el módulo `PURIFICADORA` del hub. Satélite **nuevo y separado** del
> existente (`purificadora`): repo propio (`ehabsa`, minúsculas como el resto
> de los satélites), marca propia, deploy propio. La app actual no se toca.

## La operación que se modela

Compra **pipas de agua cruda** → máquina PORTAQUA BPS3 (bomba → tanque clorada →
tanque purificada → sellado → dos boquillas, formatos 20 L / 19 L, con contador
en la HMI) → lavado y llenado de garrafones → **entrega por camión a
dependencias de gobierno** con recolección de vacíos → facturación consolidada
mensual, pago a 30–45 días.

## Decisiones de arquitectura

1. **Hub compartido, satélite nuevo.** Los modelos viven en el hub por
   `companyId`; el satélite es una SPA React/Vite sin base de datos propia
   (patrón de `docs/INTEGRATION-GUIDE-SATELLITE-APPS.md`). Checklist por
   satélite: scaffold de 5 archivos, `TOKEN_KEY` propio, origen en
   `API_ALLOWED_ORIGINS`, páginas sólo de esta operación.
2. **Todo lo nuevo es aditivo** bajo `/api/purificadora/*` con
   `requireMembership` + `requireModule(companyId, "PURIFICADORA")`. La app de
   la otra empresa (la existente) no cambia.
3. **Saldos siempre derivados, nunca columnas editables** — el saldo de envases
   es Σ movimientos, igual que el kardex de refacciones del automotriz.
4. **El contador de la máquina se captura a mano al cierre del turno.** La
   integración con el PLC (Modbus) NO se promete: es fase futura y depende del
   fabricante.
5. **Asientos contables sólo vía `src/lib/accounting/postings.ts`**, con
   `fuente = PURIFICADORA` y `referenciaTipo` nuevos por evento.
6. **IVA tasa 0%** (agua en envases > 10 L, Art. 2-A LIVA) ya modelado en
   `PurifConfig`. Gobierno paga tarde → CFDI **PPD** → los complementos de pago
   ya se detectan en el hub, en ambos sentidos.

## Qué se reutiliza (verificado, 38 rutas vivas)

Compras a proveedores con partidas y crédito (`PurifCompra`/`PurifCompraItem`),
catálogo de insumos (`PurifInsumo`), gastos por categoría (`PurifGasto`), ventas
y entregas en ruta con corte del día (`PurifVenta`/`PurifEntrega`/`PurifCorte`),
precio por cliente (`PurifClienteConfig`), sucursales (`PurifSucursal`), estado
de cuenta mensual + facturación idempotente (`/reportes/estado-cuenta`), portal
del cliente (`PurifPortalAccount`), usuarios con puesto (`PurifPuesto`), y del
hub: CFDI 4.0, complementos, bancos y conciliación, contabilidad y nómina
completa.

## Los cuatro bloques nuevos

### 1 · Producción (el ciclo del agua)

```prisma
PurifPipa            // recepción de agua cruda
  fecha, supplierId, litros, precio, compraId?  // liga a PurifCompra AGUA_CRUDA
PurifLoteProduccion  // un turno de la máquina
  fecha, turno, litrosEntrada, llenados20L, llenados19L,  // contadores HMI al cierre
  lavados, operadorId  // merma y rendimiento DERIVADOS, no almacenados
```

Rendimiento = (llenados20L×20 + llenados19L×19) / litrosEntrada. La pantalla
espeja el diagrama de la PORTAQUA (cruda → clorada → purificada → sellado →
boquillas) para que el operador reconozca su máquina.

### 2 · Envases en comodato (el ciclo del garrafón)

```prisma
PurifEnvaseMovimiento
  tipo: SALIDA_LLENO | RETORNO_VACIO | BAJA_ROTO | ALTA_COMPRA
  cantidad, fecha, customerId?, sucursalId?, remisionId?
// saldo por cliente = Σ salidas − Σ retornos — SIEMPRE derivado
```

Alerta cuando el saldo de una dependencia crece N semanas seguidas.

### 3 · Remisiones y contratos de gobierno

```prisma
PurifContrato
  customerId, numero, vigenciaInicio/Fin, precioGarrafon, topeMonto, diasPago
PurifRemision
  folio R-####, contratoId, sucursalId?, garrafonesEntregados,
  vaciosRecogidos,           // el mismo viaje registra ambos
  choferId, recibioNombre, evidencia (firma/foto del sello),
  estado: ENTREGADA → FACTURADA, invoiceId?
```

La cartera se lee por dependencia: remitido sin facturar → facturado por cobrar
→ cobrado, con días transcurridos contra `diasPago` del contrato. El estado de
cuenta mensual y el CFDI consolidado ya existen; se les agrega la dimensión
contrato y las remisiones anexas.

### 4 · Normatividad (COFEPRIS / NOM-201-SSA1-2015)

```prisma
PurifBitacora
  tipo: CLORO_RESIDUAL | LAVADO_TANQUES | CAMBIO_FILTROS | LAMPARA_UV |
        FUMIGACION | LIMPIEZA
  fecha, turno?, valor?, responsable, observaciones?
PurifAnalisis
  tipo: MICROBIOLOGICO | FISICOQUIMICO | METALES, laboratorio, fecha,
  resultado, vigenciaHasta, archivoPdf
```

Alertas de vencimiento (análisis, cambio de filtro por días/uso). El expediente
se imprime completo para una visita de la autoridad.

### Extensión menor

`PurifPuesto` += `PRODUCCION`, `CHOFER` (aditivo; los valores existentes no
cambian). La app del chofer captura remisiones **sin señal** y sincroniza al
volver — cola local en el dispositivo, idempotente por folio.

## Pantallas (18 mapeadas; 8 construidas como mockups)

Ver `README.md` de esta carpeta. Construidas: tablero, producción, envases,
gobierno (contratos), cartera, estado de cuenta, normatividad, remisión (móvil).
Pendientes de construir en el satélite: kardex de envases, recepción de pipa
(formulario), compras (existe API), nómina (existe hub), bancos (existe hub),
portal con saldo de envases.

## Estimación y orden de construcción

**3–5 semanas** los cuatro bloques + satélite. Orden: modelos y kardex de
envases → remisiones con app de chofer → producción → contratos/cartera →
normatividad → pulido del portal. La regla del hospital aplica: primero lo que
cobra (remisión → estado de cuenta → CFDI), al final lo que reporta.

## Verificación

- `node scripts/validate-purificadora-postings.mjs` antes de cualquier demo.
- Invariantes en tests: saldo de envases = Σ movimientos; una remisión no puede
  facturarse dos veces (`estado` + unique por folio); litros embotellados ≤
  litros de entrada del lote.
- Los mockups se regeneran con `scratchpad/deck/planta/` (HTML + Chromium) y el
  deck con `build-planta.js`; QA geométrico con `qa.py`.
