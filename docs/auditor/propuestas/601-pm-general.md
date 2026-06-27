# Checks diarios — Régimen 601 (Personas Morales, Régimen General de Ley)

> Propuesta para extender el auditor existente (`src/lib/fiscal/audit/`) con checks
> que un *contador* real revisa **cada día** para una PM 601 (constructoras,
> comercializadoras, SAPIs de servicios). Se diseñan como detectores puros + cargadores
> Prisma (estilo `duplicados.ts` / `pue-pagos.ts`), que `runAuditForCompany()` corre y
> persiste como `FiscalHallazgo` idempotente. El cron diario ya existe:
> `POST /api/cron/fiscal-audit` → `runAuditForCompany` por empresa, y el push matutino
> `revision-digest` resume los hallazgos `ABIERTO`.

---

## 1. Perfil del contribuyente (601)

**Quién es.** Persona Moral en el Régimen General de Ley (Título II LISR). Es el núcleo de
clientes de ContabilidadOS: constructoras, comercializadoras y SAPIs de servicios. Características
fiscales que mandan en el día a día:

- **ISR sobre devengado / nominal, NO sobre flujo.** A diferencia de una PF/RESICO, la PM 601
  acumula el ingreso al momento de emitir el CFDI o entregar el bien (Art. 17 LISR), no al cobro.
  Pero el **IVA sí es de flujo** (causado al cobro, acreditable al pago — Art. 1-B / 5-I LIVA).
  Esa asimetría es la fuente #1 de errores: un PPD cobrado sin REP, o un PUE no pagado.
- **Pagos provisionales mensuales de ISR** con coeficiente de utilidad (Art. 14 LISR), **IVA
  mensual** (Art. 5-D LIVA), **DIOT**, **retenciones de ISR** (nómina/honorarios/arrendamiento,
  Art. 96/106/116), todo al **día 17**. Anual al **31 de marzo** (Art. 9/76-V).
- **Contabilidad electrónica** obligatoria: catálogo + balanza al SAT (Art. 28 CFF), CSD/e.firma
  vigentes para timbrar y declarar.
- **Construcción** añade casa-habitación exenta de IVA (Art. 9-II LIVA, ya cubierto), retención de
  IVA en subcontratación/mano de obra, anticipos y estimaciones.

**Riesgos diarios que un contador 601 vigila (los que se pueden volver cron):**

1. **CFDIs recién llegados mal formados** que distorsionan la base: PPD cobrado sin complemento de
   pago (IVA no causado y multa por no expedir REP), efectivo > $2,000, combustible en efectivo,
   moneda extranjera sin TC. *(varios ya existen)*
2. **Operaciones con EFOS / contraparte en 69-B** → deducción e IVA improcedentes. *(ya existe vía `efos-screening`)*
3. **CFDIs cancelados después de declarados** que dejan ingreso/IVA inflado o deducción fantasma.
4. **Vencimientos de obligaciones del mes** (IVA/ISR/DIOT/retenciones al 17) y declaraciones no presentadas.
5. **CSD / e.firma por vencer** → sin ellos no se timbra ni se declara (paro operativo).
6. **Opinión de cumplimiento 32-D negativa / CSF con obligación omitida** → riesgo de contrato y de restricción de CSD.
7. **Banco desactualizado / conciliación incompleta** que rompe el IVA de flujo. *(ya existe)*
8. **Retenciones de IVA en construcción / subcontratación** no trasladadas o no enteradas.

---

## 2. Tabla priorizada de checks diarios

Leyenda automatizable: **sí** = corre hoy con modelos actuales · **parcial** = corre pero con
heurística/falsos positivos o cobertura incompleta · **no** = falta dato (ver §4).

| Check | Qué cacha (claro) | Fundamento | Fuente de datos (modelo Prisma real) | ¿Automatizable hoy? | Severidad | Frecuencia ideal |
|---|---|---|---|---|---|---|
| `cfdi.ppd.sin_rep` ⭐ | PPD emitido (ingreso) ya cobrado pero **sin complemento de pago** timbrado → IVA no causado + obligación de REP incumplida | LIVA 1-B/17; CFF 29-A; RMF 2.7.1.32 | `Invoice{tipo:INGRESO,metodoPago:"PPD",status:"STAMPED"}` cruzado con `PagoDoctoRelacionado.parentUuid` y `BankTransaction` (cobro) | **parcial** (sí detecta "no hay REP"; el "ya se cobró" requiere conciliación o REP recibido) | error | diaria |
| `cfdi.cancelado_post_declaracion` ⭐ | CFDI **cancelado** cuyo periodo (mes de `fecha`) ya tiene declaración `FILED/PAID` → ingreso/IVA o deducción quedó mal declarado | CFF 29-A, 32 (complementaria) | `Invoice{status:"CANCELLED",canceladaAt}` + `TaxDeclaration{status in FILED,PAID, periodo}` | **sí** | error | diaria |
| `csd.fiel.por_vencer` ⭐ | **CSD o e.firma** vencen en ≤ N días (o ya vencidos) → no se puede timbrar ni declarar | CFF 17-D, 17-H | `Company.csdVigencia`, `Company.fielVigencia` | **sí** | error | diaria |
| `obligacion.vencimiento.proximo` ⭐ | Obligación del mes (IVA/ISR/DIOT/retenciones) **vence en ≤ N días y no está presentada** | LISR 14; LIVA 5-D; CFF 31/32 | `CompanyObligation{tipo,diaVencimiento,activa}` − `TaxDeclaration{tipo,periodo,status FILED/PAID}` | **sí** | warn→error (sube al acercarse) | diaria |
| `efos.contraparte.definitivo` | Proveedor/cliente en lista 69-B definitiva → deducción/IVA improcedente | CFF 69-B | `Customer.rfc` vs lista EFOS | **sí** *(ya existe `efos-screening`)* | error | diaria |
| `iva.retencion.construccion.faltante` | CFDI de **subcontratación / mano de obra** recibido sin la retención de IVA correspondiente | LIVA 1-A; (subcontratación) | `Invoice{tipo:EGRESO,items.claveProdServ}` + `InvoiceTax{tipo:IVA,retencion}` | **parcial** (heurística por ClaveProdServ; falta marcar "es subcontratación") | warn | diaria |
| `cumplimiento.opinion.negativa` | Opinión 32-D **NEGATIVA** o con obligaciones omitidas (cambio detectado) | CFF 32-D | `ComplianceSnapshot{tipo:"SAT_OPINION"}` | **sí** *(ya vía `persistComplianceResult`/`compliance-sync`)* | error | diaria |
| `cfdi.posible_duplicado` | 2+ CFDIs misma contraparte/importe/día | CFF 29-A | `Invoice` agrupado | **sí** *(ya existe)* | warn | diaria |
| `iva.pue.sin_pago` | PUE egreso con IVA acreditado sin pago conciliado | LIVA 5-I | `Invoice` + conciliación banco | **sí** *(ya existe)* | warn | diaria |
| `cfdi.rep.fecha_pago_anterior_factura` | REP con FechaPago anterior a la factura | CFF 29-A; LIVA 1-B | `PagoDoctoRelacionado` | **sí** *(ya existe)* | warn | diaria |
| `banco.movimientos_desactualizados` | Cuenta con historial sin movimientos > 14 días | CFF 28 | `BankAccount` + `BankTransaction` | **sí** *(ya existe)* | warn | diaria |
| `declaraciones.faltantes` | Acuses faltantes que rompen el arrastre | LISR 14 | `TaxDeclaration` cobertura | **sí** *(ya existe)* | warn | diaria |
| `deduccion.efectivo.limite` / `.combustible.efectivo` | Pago efectivo > $2,000 / combustible en efectivo | LISR 27-III | `Invoice{formaPago,items}` | **sí** *(ya existe)* | warn/error | diaria |
| `iva.acreditamiento.proporcion` | Tiene actos exentos (casa-habitación) + IVA acreditable al 100% → debe prorratearse | LIVA 5-V/5-A | `InvoiceTax{factor:"EXENTO",base}` + IVA acreditable | **no** (falta cálculo de proporción mensual) | warn | mensual |
| `nomina.timbrada_vs_entero` | Nómina timbrada (ISR retenido) sin declaración `RETENCIONES_ISR` del periodo | LISR 96 | `Invoice{tipo:NOMINA,isrRetenidoNomina}` + `TaxDeclaration{tipo:RETENCIONES_ISR}` | **parcial** | warn | mensual |
| `cfdi.ingreso_sin_conciliar.antiguo` | Ingreso emitido viejo nunca cobrado (cuenta x cobrar incobrable / dato faltante) | — operativo | `Invoice` + `BankTransaction` | **parcial** | info | semanal |

---

## 3. Top checks automatizables (lógica concreta)

Estilo: cada uno es un **cargador** Prisma `cargarX(companyId, fecha)` + un **auditor** puro
`auditarX(items): Hallazgo[]`, ensamblado en `runAuditForCompany` junto a los demás (igual que
`cargarPosiblesDuplicados`/`auditarDuplicados`). El `dedupeKey` lo deriva `dedupeKey(h)` de
`service.ts` a partir de `checkClave + referencias`, así que **las referencias deben ser estables
entre corridas** para no generar ruido.

---

### 3.1 ⭐ `cfdi.ppd.sin_rep` — PPD emitido sin complemento de pago (REP)

**Por qué importa.** En una PM 601 el IVA se causa **al cobro** (Art. 1-B LIVA). Un ingreso PPD
que ya se cobró pero al que no se le timbró REP: (a) incumple la obligación de expedir el
complemento dentro del plazo (multable, RMF 2.7.1.32 / Art. 29-A CFF) y (b) deja el IVA trasladado
fuera del mes que corresponde. Es lo primero que revisa un contador cuando entra dinero a la cuenta.

```ts
// audit/ppd-sin-rep.ts  (cargador + auditor, estilo duplicados.ts)
export interface PpdSinRep {
  invoiceId: string;
  label: string;          // serie+folio o uuid[:8]
  fecha: string;          // YYYY-MM-DD emisión
  total: number;
  cobradoEn?: string;     // fecha del BankTransaction conciliado (si hay)
  diasDesdeCobro?: number;
}

// Carga PPD ingreso STAMPED sin ningún PagoDoctoRelacionado que lo referencie,
// priorizando los que YA se cobraron (BankTransaction conciliado) — esos son error
// duro; los aún no cobrados son sólo recordatorio (no se emiten, evita ruido).
export async function cargarPpdSinRep(companyId: string, hoy: Date): Promise<PpdSinRep[]> {
  const ppd = await prisma.invoice.findMany({
    where: { companyId, tipo: "INGRESO", metodoPago: "PPD", status: "STAMPED",
             uuid: { not: null } },
    select: { id: true, uuid: true, serie: true, folio: true, fecha: true, total: true,
              bankTransactions: { select: { fecha: true } } },
  });
  if (ppd.length === 0) return [];

  // UUIDs que YA tienen REP (el complemento referencia parentUuid).
  const uuids = ppd.map(p => p.uuid!) as string[];
  const conRep = await prisma.pagoDoctoRelacionado.findMany({
    where: { parentUuid: { in: uuids }, pagoInvoice: { companyId, status: { not: "CANCELLED" } } },
    select: { parentUuid: true },
  });
  const tieneRep = new Set(conRep.map(r => r.parentUuid));

  const items: PpdSinRep[] = [];
  for (const p of ppd) {
    if (tieneRep.has(p.uuid!)) continue;            // ya complementado → ok
    const cobro = p.bankTransactions[0]?.fecha;     // cobro conciliado (si existe)
    if (!cobro) continue;                           // sin evidencia de cobro → no se emite (evita ruido)
    const dias = Math.floor((hoy.getTime() - cobro.getTime()) / 86_400_000);
    items.push({ invoiceId: p.id, label: etiqueta(p.serie, p.folio, p.uuid),
                 fecha: p.fecha.toISOString().slice(0,10), total: p.total,
                 cobradoEn: cobro.toISOString().slice(0,10), diasDesdeCobro: dias });
  }
  return items;
}

export function auditarPpdSinRep(items: PpdSinRep[]): Hallazgo[] {
  return items.map((i): Hallazgo => ({
    checkClave: "cfdi.ppd.sin_rep",
    severidad: "error",
    mensaje: `La factura PPD ${i.label} por ${fmt(i.total)} aparece cobrada el ${i.cobradoEn} ` +
             `(hace ${i.diasDesdeCobro} días) pero NO tiene complemento de pago (REP) timbrado. ` +
             `Sin el REP el IVA no se reconoce en el mes del cobro y se incumple la obligación de expedirlo.`,
    referencias: [i.invoiceId],                     // estable entre corridas
    fundamento: { ley: "LIVA", articulo: "1-B" },
    sugerencia: "Timbra el complemento de pago (REP) con la FechaPago real del cobro. " +
                "Verifica que el IVA quede en el mes de cobro; si ya declaraste ese mes sin él, valora complementaria.",
  }));
}
```

**Hallazgo emitido:** `error` `cfdi.ppd.sin_rep`, `referencias:[invoiceId]`, fundamento LIVA 1-B.
**Gating anti-ruido:** sólo emite si hay cobro conciliado (`bankTransactions`); sin conciliación
de banco no juzga (igual filosofía que `cargarPueSinPago`).

---

### 3.2 ⭐ `cfdi.cancelado_post_declaracion` — CFDI cancelado de un periodo ya declarado

**Por qué importa.** Cancelar un CFDI de un mes cuya `IVA_MENSUAL`/`ISR_PROVISIONAL` ya está
`FILED/PAID` significa que lo declarado quedó inflado (si era ingreso) o que se dedujo algo que
desapareció (si era egreso). El contador debe valorar una complementaria. Hoy nadie lo vigila.

```ts
// audit/cancelado-post-declaracion.ts
export interface CanceladoDeclarado {
  invoiceId: string;
  label: string;
  tipo: "INGRESO" | "EGRESO";
  periodo: string;            // "YYYY-MM"
  total: number;
  declaraciones: string[];    // tipos ya presentados de ese periodo (IVA_MENSUAL, …)
}

export async function cargarCanceladosDeclarados(companyId: string): Promise<CanceladoDeclarado[]> {
  // Cancelados recientes (limita a, p.ej., últimos 18 meses para no recargar).
  const cancelados = await prisma.invoice.findMany({
    where: { companyId, status: "CANCELLED", tipo: { in: ["INGRESO","EGRESO"] },
             canceladaAt: { not: null } },
    select: { id: true, tipo: true, serie: true, folio: true, uuid: true, fecha: true, total: true },
  });
  if (cancelados.length === 0) return [];

  const periodos = [...new Set(cancelados.map(c => c.fecha.toISOString().slice(0,7)))];
  const decls = await prisma.taxDeclaration.findMany({
    where: { companyId, periodo: { in: periodos },
             tipo: { in: ["IVA_MENSUAL","ISR_PROVISIONAL","DIOT"] },
             status: { in: ["FILED","PAID"] } },
    select: { tipo: true, periodo: true },
  });
  const declPorPeriodo = new Map<string, string[]>();
  for (const d of decls) (declPorPeriodo.get(d.periodo) ?? declPorPeriodo.set(d.periodo, []).get(d.periodo)!).push(d.tipo);

  const items: CanceladoDeclarado[] = [];
  for (const c of cancelados) {
    const periodo = c.fecha.toISOString().slice(0,7);
    const presentadas = declPorPeriodo.get(periodo);
    if (!presentadas?.length) continue;             // su periodo no está declarado → nada que corregir
    items.push({ invoiceId: c.id, label: etiqueta(c.serie, c.folio, c.uuid),
                 tipo: c.tipo as "INGRESO"|"EGRESO", periodo, total: c.total,
                 declaraciones: [...new Set(presentadas)] });
  }
  return items;
}

export function auditarCanceladosDeclarados(items: CanceladoDeclarado[]): Hallazgo[] {
  return items.map((i): Hallazgo => ({
    checkClave: "cfdi.cancelado_post_declaracion",
    severidad: "error",
    mensaje: `El CFDI de ${i.tipo === "INGRESO" ? "ingreso" : "egreso"} ${i.label} por ${fmt(i.total)} ` +
             `fue cancelado, pero su periodo ${i.periodo} ya tiene declaración presentada ` +
             `(${i.declaraciones.join(", ")}). Lo declarado ya no coincide con los CFDIs vivos.`,
    referencias: [i.invoiceId],
    fundamento: { ley: "CFF", articulo: "32" },
    sugerencia: i.tipo === "INGRESO"
      ? "Revisa si el ingreso/IVA trasladado declarado de más amerita declaración complementaria del periodo."
      : "Revisa si la deducción / IVA acreditable declarado de más amerita complementaria del periodo.",
  }));
}
```

**Hallazgo:** `error` `cfdi.cancelado_post_declaracion`, fundamento CFF 32. Referencias estables
(`invoiceId`), así que se auto-resuelve solo si se presenta la complementaria que reordena el periodo.

---

### 3.3 ⭐ `csd.fiel.por_vencer` — CSD / e.firma por vencer o vencidos

**Por qué importa.** Sin CSD vigente la PM **no timbra CFDIs**; sin e.firma **no presenta
declaraciones ni la DIOT**. Es un paro operativo total y 100% prevenible. El dato ya está en
`Company.csdVigencia` / `Company.fielVigencia`.

```ts
// audit/credenciales-vigencia.ts   — opera sobre la Company, no sobre CFDIs.
const UMBRAL_DIAS = 30;   // avisar con un mes de anticipación

export interface CredencialVigencia {
  tipo: "CSD" | "e.firma";
  vigencia: string;       // YYYY-MM-DD
  dias: number;           // negativo = ya venció
}

export function auditarCredencialesVigencia(
  company: { csdVigencia: Date | null; fielVigencia: Date | null }, hoy: Date,
): Hallazgo[] {
  const out: Hallazgo[] = [];
  const check = (tipo: "CSD" | "e.firma", v: Date | null, ley: string, art: string, motivo: string) => {
    if (!v) return;
    const dias = Math.floor((v.getTime() - hoy.getTime()) / 86_400_000);
    if (dias > UMBRAL_DIAS) return;
    const vencido = dias < 0;
    out.push({
      checkClave: tipo === "CSD" ? "csd.por_vencer" : "fiel.por_vencer",
      severidad: vencido ? "error" : "warn",
      mensaje: vencido
        ? `El ${tipo} venció el ${v.toISOString().slice(0,10)} (hace ${-dias} días): ${motivo}.`
        : `El ${tipo} vence en ${dias} días (${v.toISOString().slice(0,10)}): ${motivo}.`,
      referencias: [`${tipo}:${v.toISOString().slice(0,10)}`],  // estable: cambia al renovar
      fundamento: { ley, articulo: art },
      sugerencia: tipo === "CSD"
        ? "Tramita/renueva el Certificado de Sello Digital en el SAT antes de que caduque para no detener el timbrado."
        : "Renueva la e.firma (FIEL) en el SAT; sin ella no puedes presentar declaraciones ni la DIOT.",
    });
  };
  check("CSD", company.csdVigencia, "CFF", "17-D", "sin él no puedes timbrar CFDIs");
  check("e.firma", company.fielVigencia, "CFF", "17-D", "sin ella no puedes declarar ni firmar la DIOT");
  return out;
}
```

**Hallazgo:** `csd.por_vencer` / `fiel.por_vencer`, `warn` si próximo, `error` si vencido.
`referencias` incluyen la fecha de vigencia → al renovar (nueva fecha) cae el viejo hallazgo y se
auto-resuelve. En `runAuditForCompany` ya se carga `company`; sólo hay que añadir `csdVigencia`,
`fielVigencia` al `select`.

---

### 3.4 ⭐ `obligacion.vencimiento.proximo` — obligación del mes por vencer y sin presentar

**Por qué importa.** El día 17 (mensuales) es la fecha más sensible del calendario 601. El contador
revisa a diario qué falta y cuántos días quedan. `declaraciones.faltantes` mira el **arrastre
histórico**; esto mira el **vencimiento inminente del periodo en curso**, que es lo urgente.

```ts
// audit/obligaciones-vencimiento.ts
export interface ObligacionPendiente {
  tipo: string;           // "IVA_MENSUAL" | "ISR_PROVISIONAL" | "DIOT" | "RETENCIONES_ISR"
  descripcion: string;
  periodo: string;        // "YYYY-MM" del periodo a presentar
  vence: string;          // YYYY-MM-DD
  dias: number;
}

export async function cargarObligacionesPorVencer(companyId: string, hoy: Date): Promise<ObligacionPendiente[]> {
  const obligaciones = await prisma.companyObligation.findMany({
    where: { companyId, activa: true, periodicidad: "MENSUAL" },
    select: { tipo: true, descripcion: true, diaVencimiento: true },
  });
  if (obligaciones.length === 0) return [];

  // Periodo a declarar = mes anterior (las mensuales se presentan el mes siguiente).
  const periodo = `${prevMonth(hoy)}`;              // "YYYY-MM"
  const tipos = obligaciones.map(o => o.tipo);
  const presentadas = await prisma.taxDeclaration.findMany({
    where: { companyId, periodo, tipo: { in: tipos as any }, status: { in: ["FILED","PAID"] } },
    select: { tipo: true },
  });
  const yaPresentado = new Set(presentadas.map(d => d.tipo));

  const out: ObligacionPendiente[] = [];
  for (const o of obligaciones) {
    if (yaPresentado.has(o.tipo)) continue;
    const vence = vencimientoDe(hoy, o.diaVencimiento);   // día 17 del mes en curso
    const dias = Math.floor((vence.getTime() - hoy.getTime()) / 86_400_000);
    if (dias > 7 || dias < -3) continue;            // ventana: avisa una semana antes, y hasta 3 días vencido
    out.push({ tipo: o.tipo, descripcion: o.descripcion, periodo,
               vence: vence.toISOString().slice(0,10), dias });
  }
  return out;
}

export function auditarObligacionesPorVencer(items: ObligacionPendiente[]): Hallazgo[] {
  return items.map((i): Hallazgo => ({
    checkClave: "obligacion.vencimiento.proximo",
    severidad: i.dias < 0 ? "error" : i.dias <= 2 ? "error" : "warn",
    mensaje: i.dias < 0
      ? `La ${i.descripcion} del periodo ${i.periodo} venció hace ${-i.dias} día(s) (${i.vence}) y no está presentada.`
      : `La ${i.descripcion} del periodo ${i.periodo} vence en ${i.dias} día(s) (${i.vence}) y sigue pendiente.`,
    referencias: [`${i.tipo}:${i.periodo}`],         // estable: una entrada por obligación/periodo
    fundamento: { ley: "CFF", articulo: "31" },
    sugerencia: `Presenta la ${i.descripcion} del periodo ${i.periodo} antes del ${i.vence} para evitar recargos y actualización (Art. 21 CFF).`,
  }));
}
```

**Hallazgo:** `obligacion.vencimiento.proximo`, sube `warn → error` conforme vence. Referencia
`tipo:periodo` → cuando se presenta la declaración, el cargador deja de emitirlo y se auto-resuelve.
Complementa, no duplica, a `declaraciones.faltantes` (que es de arrastre histórico).

---

## 4. Datos que aún no tenemos (gaps que bloquean ciertos checks)

1. **Marca de "subcontratación / servicios con retención de IVA".** Para `iva.retencion.construccion.faltante`
   (Art. 1-A LIVA) hay que saber con certeza si un EGRESO es mano de obra subcontratada. Hoy sólo
   tenemos `InvoiceItem.claveProdServ` + `descripcion` (heurística ruidosa). Falta: un flag derivable
   o capturable a nivel CFDI/proveedor (p. ej. en `Supplier` o `SupplierTerms`) que indique "sujeto a
   retención de IVA".

2. **Proporción de acreditamiento de IVA (Art. 5-V / 5-A LIVA).** `iva.acreditamiento.proporcion`
   requiere comparar actos gravados vs exentos del mes. Tenemos el insumo (`InvoiceTax.factor:"EXENTO"`
   con `base`, y el IVA trasladado), pero **no existe el cálculo mensual de proporción** ni dónde
   persistirlo. Es un check mensual, no diario.

3. **Cobro real de PPD sin conciliación bancaria.** `cfdi.ppd.sin_rep` sólo es confiable cuando la
   empresa concilia banco (`BankTransaction.invoiceId`) o cuando importamos el **REP recibido** del
   cliente. Para empresas sin banco conectado, no podemos afirmar "ya se cobró" → el check queda en
   modo recordatorio suave. Falta: señal de cobro independiente del banco (p. ej. REP emitido por la
   contraparte sincronizado vía Descarga Masiva de recibidos).

4. **Fecha de presentación / vencimiento autoritativa por declaración.** `TaxDeclaration.fechaLimitePago`
   existe pero no siempre está poblada; el check de vencimiento la deriva de `CompanyObligation.diaVencimiento`.
   Falta: respetar **prórrogas por dígito del RFC** (Art. 5.1 Decreto / RMF) y días inhábiles, para no
   marcar "vencido" un día que el SAT aún admite.

5. **DIOT vs CFDIs recibidos.** No hay un cruce que valide que la DIOT del periodo refleje todos los
   proveedores con IVA acreditable de ese mes (`Invoice{tipo:EGRESO}` agregados por RFC vs el contenido
   de la DIOT). Tenemos `TaxDeclaration{tipo:DIOT}` pero su detalle por proveedor no está modelado
   (sólo `diotXmlUrl`).

6. **Estado real de la opinión 32-D / IMSS en tiempo real.** Depende de que `compliance-sync` haya
   corrido (Syntage/scraping). Los checks que leen `ComplianceSnapshot` son tan frescos como el último
   fetch; un snapshot viejo puede ocultar una negativa reciente. Falta: vigilar la **antigüedad** del
   snapshot y avisar si está obsoleto.
