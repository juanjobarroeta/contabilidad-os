# Checks diarios automatizables para régimen 626 — RESICO (PF y PM)

Propuesta de extensión del framework de auditoría (`src/lib/fiscal/audit/`) y de los crons
(`src/app/api/cron/`). NO modifica el repo; sólo describe checks nuevos, su fundamento, la
fuente de datos real y el `FiscalHallazgo` que emitirían. Estilo: cada check es puro
(`evaluar(...): Hallazgo[]`) y los datos los carga un loader que vive en `service.ts`, igual
que `cargarBancoDesactualizado`, `cargarPosiblesDuplicados`, etc.

---

## 1. Perfil 626 y riesgos de EXPULSIÓN que justifican el monitoreo diario

### Detección de variante (ya existe)
`detectResicoKind(regimenFiscal, rfc)` en `src/lib/resico.ts` decide PF/PM por
`regimenFiscal === "626"` + longitud de RFC (13 = PF, 12 = PM). El contexto del auditor
(`Contexto` en `src/lib/fiscal/rules/types.ts`) ya trae `regimen` y `tipoPersona`, así que un
check puede gatear con `aplicabilidad: { regimenes: ["626"], tipoPersona: "PF" | "PM" | "*" }`.

### RESICO PF (626, Art. 113-E a 113-J LISR)
- ISR mensual = tarifa progresiva (`TARIFA_RESICO_PF_MENSUAL` en `resico.ts`, ~1.00%–2.50%)
  sobre **ingresos efectivamente cobrados** (base flujo), **sin deducciones** y sin coeficiente.
- Límite de ingresos: **3.5 MDP** anuales (Art. 113-E). Excederlo => sale de RESICO.
- Retención del **1.25%** de ISR cuando factura a Persona Moral (Art. 113-J); es pago
  provisional acreditable. El modelo ya lo contempla: `TaxDeclaration.isrSaldoFavor` documenta
  el excedente de la retención 1.25% (ver comentario en `schema.prisma` líneas 1097-1101).
- Obligación de **declaración mensual** (ISR) y **anual** (Art. 113-F).

### RESICO PM (626, Art. 206-215 LISR)
- Base flujo (cobrado/pagado) pero con deducciones, similar a Art. 14 (ver nota en `resico.ts`:
  "mismo Art. 14 LISR ... pero basado en flujo"). Límite de ingresos: **35 MDP** anuales.
- Sin retención del cliente (eso es exclusivo de PF).

### Causales de EXPULSIÓN / pérdida del régimen que vuelven valioso el check DIARIO
La ley (Art. 113-E, párr. 6-12) saca al contribuyente de RESICO y lo manda a Actividad
Empresarial / régimen general — frecuentemente **sin opción de regresar** — cuando:

1. **Opinión de cumplimiento (32-D) NEGATIVA**. RESICO exige opinión positiva permanente.
   Hoy ya jalamos `SAT_OPINION` vía Syntage (`compliance-sync` → `persistComplianceResult` →
   `ComplianceSnapshot`), y `diff.ts::evaluarOpinion` ya emite
   `cumplimiento.sat_opinion.negativa` (severidad `error`). Falta el matiz "para un 626 esto es
   causal de expulsión", no sólo "bloquea contratos".
2. **Declaración mensual/anual OMITIDA**. Dejar de declarar el plazo (incl. estando en ceros)
   es causal directa de expulsión. Hoy `auditarDeclaracionesFaltantes` mira *acuses faltantes
   para el arrastre*, no *obligaciones vencidas no presentadas* — vacío parcial.
3. **Exceder el límite de ingresos** (3.5 MDP PF / 35 MDP PM). En cuanto se rebasa, el mes
   siguiente ya tributa en otro régimen. Hay que avisar **antes** de cruzar el umbral, no en la
   anual. No existe tracker hoy.
4. **No emitir la factura global a público en general (mensual)** cuando se hacen ventas al
   público (RFC genérico `XAXX010101000`). En RESICO PF la omisión reiterada de facturación es
   causal de salida. El sistema ya entiende `XAXX010101000` (ver `facturas/route.ts:193`,
   `stamp.ts:65`), pero no audita "tuviste ventas a público y no hay global del mes".
5. Otras: RFC **SUSPENDIDO/CANCELADO** en el padrón (ya lo emite `diff.ts::evaluarCsf` →
   `cumplimiento.csf.estatus`), y salida del régimen detectable porque la CSF deja de listar
   `626` (ya lo emite `cumplimiento.csf.regimen`).

El monitoreo diario es alto valor porque (3) y (4) son **acumulativos** (un día tarde de aviso
= un mes ya perdido) y (1)/(2) tienen ventana de regularización corta antes de que la salida
sea firme.

---

## 2. Tabla priorizada de checks diarios

Severidad: `error` = riesgo de expulsión/incumplimiento; `warn` = corrige pronto; `info`.
Automatizable: **sí** = con modelos actuales; **parcial** = falta un dato/flag; **no** = falta fuente.

| # | Check (clave propuesta) | Qué cacha | Fundamento | Fuente de datos (modelo real) | ¿Automatizable hoy? | Sev | Frec |
|---|---|---|---|---|---|---|---|
| 1 | `resico.opinion.negativa` | Opinión 32-D NEGATIVA / cambió a negativa → causal de expulsión | CFF 32-D; LISR 113-E | `ComplianceSnapshot(tipo="SAT_OPINION")` + `diff.ts::evaluarOpinion` | **sí** (ya emite; falta encuadre 626) | error | diaria |
| 2 | `resico.ingresos.limite` | Ingresos cobrados acumulados del ejercicio vs 3.5 MDP (PF) / 35 MDP (PM); avisa al 80/90/100% | LISR 113-E (PF), 206/214 (PM) | `Invoice` (tipo INGRESO, STAMPED, no CANCELLED) sumando `total`; régimen+RFC vía `detectResicoKind` | **parcial** (umbral disponible; base "cobrado" aproximada con stamped) | warn→error | diaria |
| 3 | `resico.declaracion.omitida` | Periodo (ISR mensual / anual) **vencido y no presentado** (FILED/PAID) | LISR 113-F; CFF 31 | `CompanyObligation` (vencimiento) + `TaxDeclaration(status, periodo)` | **parcial** (lógica de vencido vs status existe dispersa; falta check unificado) | error | diaria |
| 4 | `resico.global.publico_faltante` | Hubo ventas a `XAXX010101000` en el mes anterior y no hay factura **global** de ese mes | RMF 2.7.1.21; LISR 113-G-V | `Invoice` (customer.rfc = `XAXX010101000`) vs factura global del periodo | **parcial** (detectamos público; falta marca de "global") | warn | diaria |
| 5 | `resico.retencion.faltante` (solo PF) | CFDI de ingreso a un cliente **PM** sin la retención de ISR 1.25% (ni IVA) registrada | LISR 113-J | `Invoice` + `InvoiceTax(tipo=ISR, retencion=true, tasa≈0.0125)`; tipo de receptor por longitud de RFC | **sí** | warn | diaria |
| 6 | `resico.deduccion.improcedente` (solo PF) | EGRESO con IVA acreditado/“deducido” cuando en RESICO PF **no hay deducciones** para ISR (señal de mala captura/expectativa) | LISR 113-E (sin deducciones) | `Invoice(tipo=EGRESO)` + `InvoiceTax` | **sí** (informativo) | info | diaria |
| 7 | `resico.efos.contraparte` | Cliente/proveedor en lista 69-B definitiva | CFF 69-B | ya cubierto por `efos-screening` → `efos.contraparte.definitivo` | **sí** (existe) | error | diaria |
| 8 | `resico.csf.salio_regimen` | La CSF dejó de listar `626` (te sacaron / te cambiaste) | CFF 27; LISR 113-E | `ComplianceSnapshot(tipo="CSF").perfil.regimenes` + `diff.ts::evaluarCsf` | **sí** (ya emite `cumplimiento.csf.regimen`) | error | diaria |
| 9 | `resico.csf.estatus` | RFC SUSPENDIDO/CANCELADO | CFF 27 | `ComplianceSnapshot CSF` + `evaluarCsf` | **sí** (existe) | error | diaria |
| 10 | `resico.banco.desactualizado` | Falta estado de cuenta → base "cobrado" del ISR incompleta | CFF 28 | ya cubierto por `banco-movimientos.ts` | **sí** (existe, aplica directo) | warn | diaria |
| 11 | `resico.iva.tasa_anomala` | RESICO PF que no causa IVA a clientes (¿exento/0%?) o IVA mal trasladado | LIVA 1/1-A | `InvoiceTax` | **no** (requiere reglas de actividad por contribuyente) | info | diaria |

**Tracker de ingresos acumulados (check #2)** y **watcher de opinión (check #1)** son los dos
pedidos explícitamente; ambos descritos en la sección 3.

---

## 3. Top 5 automatizables hoy — pseudocódigo vs. modelos reales

Estilo: igual a `audit/checks.ts` (puro, `getRule` para umbrales cuando exista la regla;
constantes RESICO tomadas de `resico.ts` para no re-hardcodear). Loaders en `service.ts`.

### 3.1 `resico.ingresos.limite` — tracker de ingresos vs. límite (PF y PM)

Loader (en `service.ts`, junto a `cargarPueSinPago`):

```ts
// Ingresos cobrados acumulados del ejercicio en curso (aprox: stamped INGRESO).
// RESICO PF es base flujo; v1 aproxima con todos los timbrados (ver nota en resico.ts).
export async function cargarIngresosAcumulados(companyId: string, fechaIso: string) {
  const ejercicio = parseInt(fechaIso.slice(0, 4), 10);
  const from = new Date(Date.UTC(ejercicio, 0, 1));
  const to   = new Date(Date.UTC(ejercicio + 1, 0, 1));
  const ingresos = await prisma.invoice.aggregate({
    where: { companyId, tipo: "INGRESO", status: "STAMPED",
             fecha: { gte: from, lt: to } },
    _sum: { total: true },
  });
  return { ejercicio, acumulado: ingresos._sum.total ?? 0 };
}
```

Check puro:

```ts
import { detectResicoKind } from "@/lib/resico";

const LIMITE_PF = 3_500_000;   // LISR 113-E  (idealmente getRule "isr.resico.limite_ingresos.pf")
const LIMITE_PM = 35_000_000;  // LISR 206/214

const resicoLimiteIngresos: FiscalCheckCtx = {
  clave: "resico.ingresos.limite",
  evaluar(acumulado: number, ctx, rfc): Hallazgo[] {
    const kind = detectResicoKind(ctx.regimen, rfc);     // "pf" | "pm" | null
    if (!kind) return [];
    const limite = kind === "pf" ? LIMITE_PF : LIMITE_PM;
    const pct = acumulado / limite;
    if (pct < 0.8) return [];
    const severidad = pct >= 1 ? "error" : "warn";
    const aviso = pct >= 1
      ? `Ya EXCEDISTE el límite de RESICO (${fmt(limite)}). A partir del mes siguiente debes tributar en régimen general (Act. Empresarial). Causal de salida del 626.`
      : `Llevas ${fmt(acumulado)} de ${fmt(limite)} (${(pct*100).toFixed(0)}%) del límite anual de RESICO. Al rebasarlo sales del régimen.`;
    return [{
      checkClave: this.clave,
      severidad,
      mensaje: aviso,
      referencias: [`${ctx.regimen}:${ctx.fecha.slice(0,4)}`], // identidad estable por ejercicio
      fundamento: { ley: "LISR", articulo: kind === "pf" ? "113-E" : "206" },
      sugerencia: pct >= 1
        ? "Avisa al SAT y prepara el cambio de régimen; revisa retenciones y CFDIs pendientes."
        : "Modera/planea ingresos restantes del ejercicio o prepárate para cambiar de régimen.",
    }];
  },
};
```

`FiscalHallazgo` emitido: `checkClave="resico.ingresos.limite"`, `referencias=["626:2026"]`
(estable entre corridas del año → el auto-resolver de `runAuditForCompany` no genera ruido),
`severidad` que escala `warn`→`error` conforme se acerca/rebasa.

### 3.2 `resico.opinion.negativa` — watcher de opinión de cumplimiento

Reusa el pipeline existente: `compliance-sync` ya persiste `SAT_OPINION` y `diff.ts` ya emite
`cumplimiento.sat_opinion.negativa` (sev `error`). La extensión 626 es **enriquecer el mensaje
y la sugerencia** cuando el contexto es RESICO, porque para un 626 la negativa **es causal de
expulsión**, no sólo bloqueo de contratos. Punto de cambio: `diff.ts::evaluarOpinion`.

```ts
// dentro de evaluarOpinion, cuando next.resultado === "NEGATIVA":
// (el caller conoce el régimen de la empresa → pasarlo como arg opcional)
const esResico = ctxRegimen === "626";
out.push({
  checkClave: "cumplimiento.sat_opinion.negativa",
  severidad: "error",
  mensaje: `La opinión de cumplimiento SAT (32-D) es NEGATIVA${transicion}` +
           (esResico ? " — en RESICO una opinión negativa es causal de salida del régimen (LISR 113-E)." : ".") +
           (next.motivos.length ? ` Motivos: ${next.motivos.join("; ")}` : ""),
  referencias: [],
  fundamento: { ley: "CFF", articulo: "32-D" },
  sugerencia: esResico
    ? "Regulariza HOY las obligaciones omitidas para no perder RESICO; revisa declaraciones vencidas."
    : "Regulariza las obligaciones omitidas de inmediato.",
});
```

`FiscalHallazgo`: `checkClave="cumplimiento.sat_opinion.negativa"`, `severidad="error"`,
`referencias=[]`, `fundamentoLey="CFF"`, `fundamentoArticulo="32-D"`. (dedupeKey ya estable.)

### 3.3 `resico.declaracion.omitida` — declaración mensual/anual vencida y no presentada

Loader: cruza obligaciones activas con lo presentado.

```ts
export async function cargarDeclaracionesOmitidas(companyId: string, hoy: Date) {
  const obligaciones = await prisma.companyObligation.findMany({
    where: { companyId, activa: true,
             tipo: { in: ["ISR_PROVISIONAL", "DECLARACION_ANUAL", "IVA_MENSUAL"] } },
    select: { tipo: true, periodicidad: true, diaVencimiento: true, mesVencimiento: true },
  });
  const presentadas = await prisma.taxDeclaration.findMany({
    where: { companyId, status: { in: ["FILED", "PAID"] } },
    select: { tipo: true, periodo: true },
  });
  const set = new Set(presentadas.map(d => `${d.tipo}:${d.periodo}`));
  // Para cada periodo cuyo vencimiento (diaVencimiento/mesVencimiento) ya pasó y
  // NO está en `set`, es una omitida. (Construir periodos como en cobertura-declaraciones.ts.)
  // ...devuelve [{ tipo, periodo, etiqueta, diasVencido }]
}
```

Check:

```ts
const resicoDeclaracionOmitida = {
  clave: "resico.declaracion.omitida",
  evaluar(omitidas): Hallazgo[] {
    if (omitidas.length === 0) return [];
    return [{
      checkClave: this.clave,
      severidad: "error",
      mensaje: `Tienes ${omitidas.length} declaración(es) vencida(s) sin presentar (${omitidas.slice(0,6).map(o=>o.etiqueta).join(", ")}). En RESICO, omitir declaraciones es causal de salida del régimen (LISR 113-E/113-F).`,
      referencias: omitidas.map(o => `${o.tipo}:${o.periodo}`),
      fundamento: { ley: "LISR", articulo: "113-F" },
      sugerencia: "Presenta las declaraciones omitidas (aun en ceros) cuanto antes para conservar RESICO y la opinión positiva.",
    }];
  },
};
```

`FiscalHallazgo`: `checkClave="resico.declaracion.omitida"`, `severidad="error"`,
`referencias=["ISR_PROVISIONAL:2026-04", ...]` (estable por tipo:periodo, igual que
`auditarDeclaracionesFaltantes`), `fundamentoLey="LISR"`, `fundamentoArticulo="113-F"`.

### 3.4 `resico.retencion.faltante` — retención 1.25% al facturar a PM (solo PF)

Trabaja sobre los CFDIs ya cargados (`loadCompanyCfdis`), pero necesita el RFC del receptor y
las filas de impuestos con `retencion`. Extender `loadCompanyCfdis` para incluir
`taxes(retencion, tipo, tasa)` (ya lo selecciona) y `customer.rfc`.

```ts
const RETENCION_ISR_RESICO = 0.0125; // LISR 113-J

const resicoRetencionFaltante = {
  clave: "resico.retencion.faltante",
  aplicabilidad: { regimenes: ["626"], tipoPersona: "PF" },
  evaluar(cfdis, ctx): Hallazgo[] {
    const out: Hallazgo[] = [];
    for (const c of cfdis) {
      if (c.direccion !== "EMITIDA") continue;
      const rfcReceptor = c.contraparteRfc ?? "";
      const esPM = rfcReceptor.length === 12;           // PM = 12 caracteres
      if (!esPM) continue;                              // 1.25% sólo aplica a clientes PM
      const tieneRetIsr = c.tieneRetencionIsr === true; // de InvoiceTax(tipo=ISR, retencion=true)
      if (tieneRetIsr) continue;
      out.push({
        checkClave: this.clave,
        severidad: "warn",
        mensaje: `CFDI de ingreso a un cliente Persona Moral (${rfcReceptor}) por ${fmt(c.total)} sin la retención de ISR del 1.25% (Art. 113-J). Esa retención es tu pago provisional acreditable.`,
        referencias: [c.id],
        fundamento: { ley: "LISR", articulo: "113-J" },
        sugerencia: "Verifica que el cliente PM retenga el 1.25% de ISR; si no, corrige el CFDI. Sin la retención registrada pagarás de más en tu declaración.",
      });
    }
    return out;
  },
};
```

`FiscalHallazgo`: `checkClave="resico.retencion.faltante"`, `severidad="warn"`,
`referencias=[invoiceId]`, `fundamentoLey="LISR"`, `fundamentoArticulo="113-J"`.

### 3.5 `resico.global.publico_faltante` — factura global mensual a público en general

```ts
export async function cargarVentasPublicoSinGlobal(companyId: string, hoy: Date) {
  // Mes anterior cerrado: ¿hubo ventas a XAXX010101000 sin estar en una factura global?
  const { from, to } = mesAnterior(hoy);
  const ventasPublico = await prisma.invoice.count({
    where: { companyId, tipo: "INGRESO", status: "STAMPED",
             fecha: { gte: from, lt: to },
             customer: { rfc: "XAXX010101000" } },
  });
  if (ventasPublico === 0) return null;
  // ¿Existe la factura GLOBAL del periodo? (hoy no hay flag explícito → ver §4)
  // const global = await ...; if (global) return null;
  return { periodo: from.toISOString().slice(0,7), ventas: ventasPublico };
}
```

`FiscalHallazgo` (cuando falte): `checkClave="resico.global.publico_faltante"`,
`severidad="warn"`, `mensaje="Tuviste N ventas a público en general en {periodo} y no
encuentro la factura global del mes. RESICO exige emitirla; omitir facturación es causal de
salida (Art. 113-G-V LISR / RMF 2.7.1.21)."`, `referencias=["GLOBAL:2026-05"]`,
`fundamentoLey="RMF"`, `fundamentoArticulo="2.7.1.21"`.

### Cableado en el cron
Todos cuelgan de `runAuditForCompany` (`service.ts`) — agregar a la lista de `hallazgos`:

```ts
const ingresos = await cargarIngresosAcumulados(companyId, fecha);
const omitidas = await cargarDeclaracionesOmitidas(companyId, new Date(fecha));
const sinGlobal = await cargarVentasPublicoSinGlobal(companyId, new Date(fecha));
const hallazgos = [
  ...auditar(cfdis, ctx),                              // ya incluiría #4 (1.25%) y #6
  ...resicoLimiteIngresos.evaluar(ingresos.acumulado, ctx, company.rfc),
  ...resicoDeclaracionOmitida.evaluar(omitidas),
  ...(sinGlobal ? [globalHallazgo(sinGlobal)] : []),
  /* …los existentes… */
];
```

La idempotencia (upsert por `companyId_dedupeKey`, auto-resolución de obsoletos) y la
persistencia ya las da `runAuditForCompany` sin cambios. El cron diario
`/api/cron/fiscal-audit` (más `compliance-sync` para #1/#8/#9) los corre.

---

## 4. Datos que aún NO tenemos

1. **Base "ingresos efectivamente cobrados" exacta** (check #2). RESICO PF es flujo: sólo cuentan
   ingresos cobrados (PUE del mes + PPD con complemento de pago). Hoy `loadCompanyCfdis` y el
   agregado por `total` usan todos los `INGRESO` STAMPED (lo reconoce `resico.ts`: "usamos todos
   los ingresos stamped del mes como aproximación"). Para exactitud falta consolidar
   `PagoDoctoRelacionado` (complementos de pago) + conciliación. → check #2 queda **parcial**.

2. **Marca/identidad de la factura GLOBAL a público en general** (check #4). El sistema entiende
   `XAXX010101000` y exige Información Global al timbrar (`facturas/route.ts:192-193`,
   `stamp.ts:65`), pero **no hay un campo en `Invoice`** que diga "esta es la global del periodo
   X" (no hay `esGlobal` / `periodoGlobal`). Sin él no podemos afirmar "falta la global del mes",
   sólo "hubo ventas a público". Falta: un flag o detección por patrón de la factura global.

3. **Umbral 3.5/35 MDP como `FiscalRule` versionada**. `resico.ts` tiene la tarifa pero el límite
   de ingresos no está en la capa `rules` (no hay `getRule("isr.resico.limite_ingresos.*")`).
   El check #2 lo hardcodea; lo ideal (contrato del repo: "consumers hardcode no fiscal
   constant") es añadir la regla con `vigencia` + `verificado`.

4. **Estado de la obligación por periodo unificado** (check #3). La info existe (`CompanyObligation`
   con `diaVencimiento`/`mesVencimiento` + `TaxDeclaration.status/periodo`) pero la lógica de
   "vencido y no presentado" está dispersa (`cobertura-declaraciones.ts` mira *acuses para
   arrastre*, no *omisión sancionable*). Falta el loader que las cruce explícitamente.

5. **Tipo de persona del RECEPTOR confiable** (check #5). Lo inferimos por longitud de RFC
   (12 = PM). Es heurística buena pero no infalible (RFCs genéricos, extranjeros
   `XEXX010101000`). `loadCompanyCfdis` además aún no expone `customer.rfc` ni un boolean
   "tiene retención ISR" — hay que añadirlos al select (los datos ya están en
   `InvoiceTax.retencion`/`Customer.rfc`).

6. **Señal directa de expulsión del SAT**. La salida de RESICO se infiere (CSF deja de listar
   `626` vía `evaluarCsf`, u opinión negativa) pero no hay un dato oficial "fecha de salida del
   régimen". Mientras tanto, `ComplianceSnapshot CSF.perfil.regimenes` + `CompanyRegimen.code`
   son la mejor proxy.
