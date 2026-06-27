# Checks diarios automatizados — Régimen 606 (Arrendamiento) y 625 (Plataformas Tecnológicas)

Propuesta de extensión del auditor "24/7 contador" (`src/lib/fiscal/audit/`) para cubrir lo que un contador revisa TODOS LOS DÍAS de estos dos régimenes de persona física. Documento de diseño — no toca código.

## Cómo encaja en el framework existente

- Cada check nuevo se materializa como un `Hallazgo` (`src/lib/fiscal/audit/types.ts`) y se persiste idempotente en `FiscalHallazgo` (`prisma/schema.prisma:2676`) vía `runAuditForCompany` (`src/lib/fiscal/audit/service.ts:163`), que ya corre diario en `POST /api/cron/fiscal-audit` (`src/app/api/cron/fiscal-audit/route.ts`).
- Los checks "puros sobre CFDI" (firman `evaluar(cfdis, ctx)`) entran al registro `CHECKS` de `src/lib/fiscal/audit/checks.ts` y se filtran por `aplicabilidad` (`run.ts:listChecks` → `aplicaAplicabilidad`). Aquí podemos gatear por `regimenes: ["606"]` / `["625"]` (campo `Aplicabilidad.regimenes`, `src/lib/fiscal/rules/types.ts:42`).
- Los checks que necesitan datos fuera del CFDI (banco, REP, declaraciones, retenciones agregadas) siguen el patrón `cargarX()` + `auditarX()` ya usado por `duplicados.ts`, `rep-fecha-pago.ts`, `banco-movimientos.ts`, `pue-pagos.ts`, `declaraciones-faltantes.ts`, y se enchufan en el array `hallazgos` de `runAuditForCompany`.
- El cálculo fiscal de referencia ya existe: `computeTaxPosition` (`src/lib/impuestos.ts:249`) ramifica `esPfArrendamiento` (606) y `esPfPlataformas` (625), usando `calcularIsrArrendamientoMensual` (`src/lib/fiscal/isr-arrendamiento.ts`) y `calcularIsrPlataformas` (`src/lib/fiscal/isr-plataformas.ts`). Los checks deben citar y reusar estas mismas funciones para no divergir del motor.

### Restricción de datos crítica (afecta a AMBOS régimenes)

`Invoice` (`prisma/schema.prisma:501`) guarda **sólo el receptor** vía la relación `customer` (`customerId` → `Customer`, línea 592). **No hay campo de emisor** (no existe `emisorRfc`/`razonSocialEmisor`; grep confirmado). Para un CFDI **recibido** (EGRESO / retención de plataforma), el `customer` adjunto representa a la contraparte (la plataforma o el arrendatario), por lo que sí podemos identificarla por `customer.rfc` / `customer.razonSocial`, pero el dato es menos limpio que un emisor dedicado. Esto limita la detección por catálogo de RFCs de plataformas (ver "Datos que aún no tenemos").

---

# RÉGIMEN 606 — ARRENDAMIENTO

## 1. Perfil y riesgos diarios

**Perfil:** Persona física (RFC 13, `regimenFiscal = "606"`) que renta inmuebles. Ingreso típico recurrente mensual (renta), pocos clientes, alta proporción de arrendatarios persona moral que **retienen 10% de ISR** (Art. 116 último párrafo LISR) y, si son PM, **retienen 2/3 del IVA** (Art. 1-A LIVA / RMF). Deducción usual: la **opcional ciega 35%** (Art. 115), aunque puede optar por reales + predial. IVA: casa habitación es **exenta** (Art. 20-II LIVA); local comercial es **gravado 16%**. Pago provisional de ISR **mensual standalone, no acumulativo** (`isr-arrendamiento.ts`).

**Lo que el contador vigila a diario:**
- ¿Se emitió la factura de renta del periodo? (renta devengada vs CFDI emitido). Una renta no facturada = ingreso omitido.
- ¿El CFDI trae bien la **retención 10% ISR** y, si aplica, la retención de IVA? Una retención faltante o mal calculada descuadra el provisional.
- ¿Casa habitación trasladando IVA por error (o local comercial SIN IVA)?
- PPD vs PUE: ¿hay rentas cobradas (depósito en banco) sin su **REP**? El IVA de arrendamiento se causa al cobro.
- ¿Depósitos en banco de renta que **no tienen CFDI** (ingreso en efectivo/transferencia no facturado)?
- Inmueble exento mezclado con gravado sin separar la **proporción de acreditamiento** (Art. 5-V).

## 2. Tabla priorizada de checks diarios (606)

| Check | Qué cacha | Fundamento | Fuente de datos (modelo real) | ¿Automatizable hoy? | Severidad | Frecuencia |
|---|---|---|---|---|---|---|
| `arr.casa_habitacion.iva_trasladado` | CFDI de renta de **casa habitación** con IVA trasladado (debe ser exenta) | LIVA Art. 20-II | `Invoice(tipo=INGRESO)` + `InvoiceTax(tipo=IVA, retencion=false)` + `items.descripcion`/`claveProdServ` | **Parcial**: hoy sólo existe el check gateado a sector CONSTRUCCION (`checks.ts:96`); falta variante 606 + señal fiable de "casa habitación" (hoy por regex de descripción) | error | Diaria |
| `arr.retencion_isr.faltante` | CFDI de renta a **arrendatario PM** sin la retención 10% ISR | LISR Art. 116 últ. párr. | `Invoice(INGRESO)` + `customer.regimenFiscal`/`rfc` (longitud 12 = PM) + `InvoiceTax(tipo=ISR, retencion=true)` | **Parcial**: tenemos retención en `taxes` y RFC del receptor; falta certeza de "PM obligado a retener" (regla por régimen del receptor) | warn | Diaria |
| `arr.retencion_iva.faltante` | Renta gravada a PM sin retención de **2/3 de IVA** | LIVA Art. 1-A-II; RMF | `Invoice(INGRESO)` + `InvoiceTax(IVA traslado vs IVA retencion)` + `customer` | **Parcial**: mismo gap de "receptor obligado a retener" | warn | Diaria |
| `arr.renta_no_facturada` | Periodo de renta sin CFDI emitido al inquilino recurrente | LISR Art. 118-III (expedir comprobantes) | `Invoice(INGRESO)` agrupado por `customer` + huecos mensuales | **No**: requiere conocer el **contrato/renta esperada** por inmueble (no existe modelo de contrato) | warn | Diaria |
| `arr.deposito_banco_sin_cfdi` | Depósito bancario que parece renta cobrada sin CFDI que lo respalde | CFF Art. 28; LISR Art. 118-III | `BankTransaction(tipo=CREDITO, status=UNMATCHED)` vs `Invoice(INGRESO)` | **Parcial**: existe conciliación (`conciliacion-pue.ts`, `BankTransaction.invoiceId`); falta heurística de "este crédito es renta" | warn | Diaria |
| `arr.ppd_cobrado_sin_rep` | Renta PPD cobrada (depósito) sin complemento de pago emitido | LIVA Art. 1-B / 17; CFF 29-A | `Invoice(INGRESO, metodoPago=PPD)` sin `PagoDoctoRelacionado` que lo liquide + `BankTransaction` conciliada | **Parcial**: el match REP↔factura ya se modela (`PagoDoctoRelacionado`, `rep-fecha-pago.ts`); falta el "cobrado en banco" como disparador | warn | Diaria |
| `arr.deduccion_ciega_vs_reales` | Egresos reales del inmueble que superan la deducción ciega 35% (conviene optar por reales) | LISR Art. 115 | `Invoice(EGRESO)` del periodo vs `0.35 × ingresosCobrados` (de `computeTaxPosition`) | **Parcial**: el motor ya asume 35% (`isr-arrendamiento.ts` v1); falta vincular egresos a inmueble | info | Mensual (revisión diaria del acumulado) |
| `arr.iva.proporcion_exento_gravado` | Mezcla de renta exenta (habitación) y gravada (local) sin proporción de acreditamiento | LIVA Art. 5-V | `InvoiceTax(factor=EXENTO, base)` + `calcularActosDelPeriodo` (`lib/fiscal/iva`) | **Sí** (ya hay `actos.proporcion` en `computeTaxPosition`); falta levantarlo como hallazgo | warn | Diaria |
| `arr.predial_no_capturado` | Optó por reales pero no hay predial pagado deducible | LISR Art. 115 | `Invoice(EGRESO)` predial | **No**: no se trackea predial (anotado en `isr-arrendamiento.ts`) | info | Mensual |

## 3. Top 3 automatizables (606) — pseudocódigo vs modelos reales

### 3.1 `arr.casa_habitacion.iva_trasladado`
Variante 606 del check ya existente `casaHabitacionConIva` (`checks.ts:96`), pero gateada a `regimenes:["606"]` en vez de sector CONSTRUCCION — para un rentista de vivienda el traslado de IVA es el error caro y diario.

```ts
const arrCasaHabitacionIva: FiscalCheck = {
  clave: "arr.casa_habitacion.iva_trasladado",
  descripcion: "Renta de casa habitación con IVA trasladado (operación exenta)",
  aplicabilidad: { regimenes: ["606"], actividades: "*", tipoPersona: "fisica" },
  severidad: "error",
  fundamento: { ley: "LIVA", articulo: "20", fraccion: "II" },
  sugerencia: "Si el inmueble es casa habitación la renta es exenta de IVA: reexpide el CFDI sin IVA trasladado (sustitución motivo 01).",
  evaluar(cfdis /* CfdiNormalizado[] */) {
    const out: Hallazgo[] = [];
    for (const c of cfdis) {
      if (c.direccion !== "EMITIDA") continue;                 // Invoice.tipo = INGRESO
      if (!c.ivaTrasladado || c.ivaTrasladado <= 0) continue;  // InvoiceTax IVA no-retención
      const esVivienda = c.items.some(i =>
        /casa habitaci|vivienda|departamento (habitacional)?/i.test(i.descripcion ?? ""));
      if (!esVivienda) continue;
      out.push({
        checkClave: this.clave, severidad: this.severidad,
        mensaje: `CFDI de renta de casa habitación por ${fmt(c.total)} con IVA trasladado de ${fmt(c.ivaTrasladado)}: la operación es exenta de IVA.`,
        referencias: [c.id], fundamento: this.fundamento, sugerencia: this.sugerencia,
      });
    }
    return out;
  },
};
```
**FiscalHallazgo emitido:** `checkClave="arr.casa_habitacion.iva_trasladado"`, `severidad="error"`, `referencias=[invoiceId]`, `fundamentoLey="LIVA"`, `fundamentoArticulo="20"`, `fundamentoFraccion="II"`.

### 3.2 `arr.retencion_isr.faltante`
Patrón `cargar/auditar` (como `duplicados.ts`) porque necesita `customer.regimenFiscal`/`rfc` (la dirección normalizada no los lleva).

```ts
// cargarRentasSinRetencion(companyId): consulta Invoice INGRESO STAMPED del ejercicio,
//   con customer { rfc, regimenFiscal }, taxes { tipo, retencion, importe }.
export function auditarRetencionIsrArrendamiento(items: RentaSinRetencion[]): Hallazgo[] {
  return items
    .filter(r => esArrendatarioPM(r.customerRfc, r.customerRegimen)) // rfc 12 dígitos = PM
    .filter(r => r.isrRetenido <= 0.005)                              // sin fila ISR retención
    .map(r => ({
      checkClave: "arr.retencion_isr.faltante",
      severidad: "warn",
      mensaje: `La renta ${r.label} a ${r.customer} (persona moral) por ${fmt(r.total)} no trae la retención del 10% de ISR que el arrendatario PM debe efectuar.`,
      referencias: [r.invoiceId],
      fundamento: { ley: "LISR", articulo: "116" },
      sugerencia: "Confirma con el arrendatario PM: debe retener el 10% de ISR (y enterarlo) y reflejarlo en el CFDI. Si falta, solicita la corrección; el provisional debe acreditar esa retención.",
    }));
}
```
**FiscalHallazgo:** `checkClave="arr.retencion_isr.faltante"`, `severidad="warn"`, `fundamentoLey="LISR"`, `fundamentoArticulo="116"`. Reusa el mismo dato de retención que `computeTaxPosition` acredita vía `flujoEfectivoAcum.isrRetenidoCobrado`.

### 3.3 `arr.iva.proporcion_exento_gravado`
Aprovecha `calcularActosDelPeriodo` (ya consumido en `computeTaxPosition`, `impuestos.ts:429`).

```ts
// cargarProporcionArrendamiento(companyId, fecha): corre computeTaxPosition del mes;
//   lee iva.actosGravados, iva.actosExentos, iva.proporcionAcreditamiento.
export function auditarProporcionArrendamiento(p: ProporcionMes): Hallazgo[] {
  if (p.actosExentos <= 0 || p.actosGravados <= 0) return []; // sólo cuando coexisten
  if (p.acreditableBruto <= 0) return [];
  return [{
    checkClave: "arr.iva.proporcion_exento_gravado",
    severidad: "warn",
    mensaje: `Coexisten rentas gravadas (${fmt(p.actosGravados)}) y exentas (${fmt(p.actosExentos)}) este mes: el IVA de gastos sólo es acreditable en proporción ${(p.proporcion*100).toFixed(1)}% (Art. 5-V). Verifica que no se acredite el 100%.`,
    referencias: [`periodo:${p.periodo}`],
    fundamento: { ley: "LIVA", articulo: "5", fraccion: "V" },
    sugerencia: "Aplica la proporción de acreditamiento gravados/(gravados+exentos) al IVA de los gastos del inmueble. El motor ya la calcula en Papeles → IVA.",
  }];
}
```
**FiscalHallazgo:** `checkClave="arr.iva.proporcion_exento_gravado"`, `severidad="warn"`, `referencias=["periodo:YYYY-MM"]` (identidad estable por periodo → el auto-resolver de `service.ts` no genera ruido).

## 4. Datos que aún no tenemos (606)
- **Contrato de arrendamiento / renta esperada por inmueble** (monto, día de cobro, inquilino, gravado/exento). Sin esto, `arr.renta_no_facturada` y la conciliación "depósito = renta" quedan en heurística. No hay modelo `Contrato`/`Inmueble`.
- **Predial pagado** deducible (anotado como pendiente en `isr-arrendamiento.ts`): bloquea comparar ciega 35% vs reales con precisión.
- **Régimen del arrendatario de forma fiable** para saber si está obligado a retener (hoy se infiere por longitud de RFC; `Customer.regimenFiscal` existe pero no siempre está poblado).
- **Etiqueta gravado/exento por inmueble** a nivel CFDI (hoy se infiere por descripción/`InvoiceTax.factor=EXENTO`).

---

# RÉGIMEN 625 — PLATAFORMAS TECNOLÓGICAS

## 1. Perfil y riesgos diarios

**Perfil:** Persona física (RFC 13, `regimenFiscal = "625"`) que obtiene ingresos por plataformas (Uber/DiDi transporte y entrega, Airbnb hospedaje, marketplaces). La **plataforma retiene ISR e IVA** sobre el ingreso y los entera (Art. 113-A LISR; Art. 18-J LIVA). La tasa de ISR depende de `Company.plataformaActividad` (`prisma/schema.prisma:195-199`): `transporte` 2.1%, `hospedaje` 4%, `servicios` 1% (`TASAS_PLATAFORMA` en `isr-plataformas.ts`). Si los ingresos por plataforma ≤ $300,000/año y opta, la retención es **pago definitivo**; si no, es **provisional** y acredita las retenciones. Los **ingresos cobrados directamente del usuario** (efectivo / fuera de la plataforma) NO llevan retención y los entera la propia PF a las mismas tasas (Art. 113-A últ. párr.).

**Lo que el contador vigila a diario:**
- ¿`plataformaActividad` está capturado? Si es null, el motor **asume "servicios" (1%, la tasa más baja)** y lo señala (`normalizarActividadPlataforma` + `plataformaActividad.asumida=true` en `impuestos.ts:457`). Tasa mal asumida = ISR mal calculado todo el mes.
- ¿Llegaron los **CFDIs de retención de la plataforma** del periodo? Sin ellos no se puede acreditar la retención ni cuadrar el ISR/IVA.
- ¿La **retención del CFDI coincide** con la tasa que corresponde a la actividad (2.1/4/1% ISR, IVA retenido)?
- **Ingresos en efectivo / directos del usuario NO retenidos** que deben pagarse aparte — el riesgo de omisión más típico del régimen.
- ¿Ingresos por plataforma acumulados rebasando **$300,000** (pierde la opción de definitivo → debe presentar provisional + anual)?
- ¿Depósitos de la plataforma en banco sin su CFDI de ingreso/retención correspondiente?

## 2. Tabla priorizada de checks diarios (625)

| Check | Qué cacha | Fundamento | Fuente de datos (modelo real) | ¿Automatizable hoy? | Severidad | Frecuencia |
|---|---|---|---|---|---|---|
| `plat.actividad_no_definida` | `Company.plataformaActividad` null → tasa ISR **asumida** (servicios 1%) | LISR Art. 113-A | `Company.plataformaActividad` (`schema:199`); `computeTaxPosition.isr.plataformaActividad.asumida` (`impuestos.ts:481`) | **Sí** (dato directo en `Company`) | error | Diaria |
| `plat.retencion.tasa_incorrecta` | Retención de ISR del CFDI ≠ tasa de la actividad (2.1/4/1%) | LISR Art. 113-A | `Invoice` + `InvoiceTax(tipo=ISR, retencion=true)` vs `TASAS_PLATAFORMA[actividad]` | **Parcial**: tenemos retención e ingreso; identificar "este CFDI es de plataforma" depende de la contraparte (sin emisor dedicado) | warn | Diaria |
| `plat.cfdi_retencion.faltante` | Depósito de plataforma sin su CFDI de retención del periodo | LISR Art. 113-A; CFF 28 | `BankTransaction(CREDITO)` vs `Invoice` con `InvoiceTax(retencion=true)` | **Parcial**: falta catálogo de RFCs de plataformas para reconocer al emisor/depositante | warn | Diaria |
| `plat.ingreso_efectivo_no_retenido` | Ingreso cobrado directo del usuario (efectivo) sin retención → la PF debe pagarlo | LISR Art. 113-A últ. párr.; LIVA Art. 18-K | `Invoice(INGRESO)` con `InvoiceTax` sin fila de retención, o `BankTransaction` directa de usuario | **Parcial**: el motor distingue causado vs retenido (`isr-plataformas.ts` remanente); falta marcar el CFDI como "directo de usuario" | error | Diaria |
| `plat.iva.retenido_vs_trasladado` | IVA retenido por la plataforma no coincide con el IVA del ingreso (Art. 18-J: 100% en transporte/hospedaje) | LIVA Art. 18-J | `InvoiceTax(IVA, retencion=true)` vs `InvoiceTax(IVA, retencion=false)` | **Parcial**: datos en `taxes`; falta regla de % retenido por actividad | warn | Diaria |
| `plat.umbral_300k` | Ingresos por plataforma acumulados del año cerca/encima de $300,000 (pierde pago definitivo) | LISR Art. 113-A/113-B | `Invoice(INGRESO, STAMPED)` acumulado del ejercicio (`ingresosAcumulados`) | **Sí** (agregación ya disponible en `computeTaxPosition`) | warn | Diaria |
| `plat.ingresos_no_cfdi` | Depósito de plataforma en banco que no se reflejó como ingreso facturado | CFF Art. 28; LISR 113-A | `BankTransaction(CREDITO, UNMATCHED)` vs `Invoice(INGRESO)` | **Parcial**: conciliación existe; falta heurística "este depósito es de plataforma" | warn | Diaria |
| `plat.retencion.no_acreditada` | Retención efectuada por la plataforma que no se está acreditando en el cálculo (cuando es provisional) | LISR Art. 113-A | `InvoiceTax(retencion=true)` vs `computeTaxPosition.isr.retencionesAcreditadas` | **Parcial**: el motor ya las acredita en flujo; falta levantar discrepancias como hallazgo | info | Mensual |

## 3. Top 3 automatizables (625) — pseudocódigo vs modelos reales

### 3.1 `plat.actividad_no_definida` (el más barato y de mayor impacto)
Dato directo en `Company`. No necesita CFDIs; sigue el patrón `cargar/auditar` leyendo la empresa.

```ts
// cargarPlataformaActividad(companyId): lee Company { regimenFiscal, plataformaActividad }.
export function auditarPlataformaActividad(c: { regimen: string; actividad: string | null }): Hallazgo[] {
  if (c.regimen !== "625") return [];
  if (c.actividad === "transporte" || c.actividad === "hospedaje" || c.actividad === "servicios") return [];
  // null / inválido → el motor asume "servicios" (1%), la tasa MÁS BAJA (riesgo de subdeclarar)
  return [{
    checkClave: "plat.actividad_no_definida",
    severidad: "error",
    mensaje: "No se ha definido la actividad de plataforma (transporte/hospedaje/servicios). El cálculo de ISR está asumiendo 'servicios' al 1% (tasa más baja); si la actividad real es transporte (2.1%) u hospedaje (4%), el ISR del periodo está subestimado.",
    referencias: [`company:${c.companyId}`],
    fundamento: { ley: "LISR", articulo: "113-A" },
    sugerencia: "Captura la actividad en el perfil de la empresa (Empresa → Plataforma). Define transporte (2.1%), hospedaje (4%) o servicios (1%).",
  }];
}
```
**FiscalHallazgo:** `checkClave="plat.actividad_no_definida"`, `severidad="error"`, `referencias=["company:<id>"]` (estable → idempotente; se auto-resuelve en cuanto se captura la actividad), `fundamentoLey="LISR"`, `fundamentoArticulo="113-A"`. Espeja exactamente la señal `plataformaActividad.asumida` de `computeTaxPosition` (`impuestos.ts:481`).

### 3.2 `plat.umbral_300k`
Agregación de ingresos del ejercicio; el umbral debe venir de la capa de reglas (`getRule`), nunca hardcodeado (convención de `checks.ts`).

```ts
// cargarIngresosPlataformaEjercicio(companyId, fecha):
//   prisma.invoice.aggregate({ where:{ companyId, tipo:"INGRESO", status:"STAMPED",
//     fecha:{ gte: yearFrom, lt: to } }, _sum:{ subtotal:true } })  // ingresos sin IVA
export function auditarUmbralPlataformas(
  ingresosAcum: number,
  umbral: number,   // getRule("isr.plataformas.umbral_definitivo", ctx) → 300_000
): Hallazgo[] {
  if (ingresosAcum < umbral * 0.9) return [];          // sólo al acercarse/rebasar
  const rebasado = ingresosAcum >= umbral;
  return [{
    checkClave: "plat.umbral_300k",
    severidad: rebasado ? "error" : "warn",
    mensaje: rebasado
      ? `Los ingresos por plataforma del ejercicio (${fmt(ingresosAcum)}) rebasan ${fmt(umbral)}: se pierde la opción de pago definitivo. Debe presentar pagos provisionales y declaración anual acreditando las retenciones.`
      : `Ingresos por plataforma del ejercicio (${fmt(ingresosAcum)}) cerca del tope de ${fmt(umbral)} para conservar el pago definitivo.`,
    referencias: [`ejercicio:${year}`],
    fundamento: { ley: "LISR", articulo: "113-A" },
    sugerencia: "Si rebasa $300,000 anuales, la retención deja de ser pago definitivo: cambia a provisionales + anual y acredita lo retenido por las plataformas.",
  }];
}
```
**FiscalHallazgo:** `checkClave="plat.umbral_300k"`, severidad escalada (warn al acercarse, error al rebasar), `referencias=["ejercicio:YYYY"]`.

### 3.3 `plat.ingreso_efectivo_no_retenido`
Detecta el ingreso del usuario cobrado fuera de plataforma (sin retención). El motor ya lo contempla como "remanente" en `isr-plataformas.ts`; aquí lo levantamos como hallazgo. Patrón `cargar/auditar` sobre CFDIs de ingreso con su desglose de retención.

```ts
// cargarIngresosPlataformaSinRetencion(companyId, fecha):
//   Invoice INGRESO STAMPED del mes con taxes { tipo, retencion, importe } y customer { rfc }.
export function auditarIngresoNoRetenido(items: IngresoPlataforma[], actividad: PlataformaActividad): Hallazgo[] {
  const tasa = TASAS_PLATAFORMA[actividad].tasa;                 // reusa el motor, no hardcode
  const sinRetencion = items.filter(i =>
    i.isrRetenido <= 0.005 &&                                    // sin fila ISR retención
    !esPlataformaConocida(i.customerRfc));                       // y NO viene de plataforma
  if (sinRetencion.length === 0) return [];
  const baseSinRet = sinRetencion.reduce((s, i) => s + i.subtotal, 0);
  const isrEstimado = round2(baseSinRet * tasa);
  return [{
    checkClave: "plat.ingreso_efectivo_no_retenido",
    severidad: "error",
    mensaje: `${sinRetencion.length} ingreso(s) por ${fmt(baseSinRet)} cobrados directamente del usuario (sin retención de plataforma). La PF debe enterar el ISR a la tasa de ${(tasa*100).toFixed(1)}% (~${fmt(isrEstimado)}) y el IVA correspondiente; estos montos NO son pago definitivo de la plataforma.`,
    referencias: sinRetencion.map(i => i.invoiceId),
    fundamento: { ley: "LISR", articulo: "113-A" },
    sugerencia: "Identifica los ingresos cobrados fuera de la plataforma (efectivo/transferencia directa del usuario): debes calcular y enterar tú el ISR (misma tasa) y el IVA. Sepáralos de los ya retenidos por la plataforma.",
  }];
}
```
**FiscalHallazgo:** `checkClave="plat.ingreso_efectivo_no_retenido"`, `severidad="error"`, `referencias=[invoiceIds...]`, `fundamentoLey="LISR"`, `fundamentoArticulo="113-A"`. **Caveat:** depende de `esPlataformaConocida()` (catálogo de RFCs de plataformas) para distinguir "directo del usuario" de "retenido por plataforma" — ver datos faltantes.

## 4. Datos que aún no tenemos (625)
- **Campo emisor en `Invoice`** (no existe `emisorRfc`/`razonSocialEmisor`). En CFDIs **recibidos** la plataforma aparece como `customer` (contraparte), pero no hay una identidad de emisor limpia; complica reconocer "esto lo emitió Uber/DiDi/Airbnb".
- **Catálogo de RFCs de plataformas** (Uber MX, DiDi, Airbnb, Rappi, Mercado Libre…) y su mapeo a actividad. Sin él, `esPlataformaConocida()` / `plat.retencion.tasa_incorrecta` / `plat.cfdi_retencion.faltante` quedan en heurística. Podría modelarse como una tabla de catálogo o una regla en la capa `rules`.
- **Marca de "ingreso directo de usuario" vs "vía plataforma"** a nivel CFDI/transacción (hoy se infiere por ausencia de retención + contraparte).
- **% de IVA retenido por actividad (Art. 18-J)** como regla parametrizada (`getRule`) para `plat.iva.retenido_vs_trasladado`.
- **Bandera de opción "pago definitivo" elegida por el contribuyente** (Art. 113-B): hoy se infiere por el umbral $300k, pero la opción es una elección formal que convendría persistir en `Company` para no asumir.
- **Umbral $300,000 y tasas como reglas versionadas** en la capa `rules` (hoy las tasas viven como constante en `isr-plataformas.ts`; los checks deberían leerlas vía `getRule` como hacen los de `checks.ts`).

---

## Resumen de enchufe en el cron diario
Todos estos checks se suman al array `hallazgos` de `runAuditForCompany` (`service.ts:181`) — los CFDI-puros vía el registro `CHECKS` con `aplicabilidad.regimenes`, y los que cruzan banco/REP/`Company`/agregados vía funciones `cargarX`+`auditarX` como las ya existentes. El cron `POST /api/cron/fiscal-audit` los ejecuta diario, son idempotentes (`dedupeKey`) y se auto-resuelven cuando el contribuyente corrige.
