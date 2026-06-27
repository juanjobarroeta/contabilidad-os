# Revisión diaria automatizada — Régimen 612 (PF con Actividades Empresariales y Profesionales)

Propuesta de checks diarios (cron) que extienden el framework de auditoría existente
(`src/lib/fiscal/audit/`). Cada check propuesto sigue el estilo de `audit/checks.ts`
(puro, lee su umbral de `getRule`, cita fundamento) o de los loaders+`auditar*` de
`service.ts` (cuando necesita banco/declaraciones). Todos emiten `FiscalHallazgo`
(`prisma/schema.prisma:2676`) de forma idempotente vía `dedupeKey` y se enganchan en
`runAuditForCompany` (`src/lib/fiscal/audit/service.ts:163`) y el cron
`/api/cron/fiscal-audit` (`src/app/api/cron/fiscal-audit/route.ts`).

---

## 1. Perfil del contribuyente (612) y riesgos diarios

**Quién es.** Persona física (RFC 13 chars → `inferTipoPersona` lo marca `PF`,
`src/lib/fiscal/rules/sector.ts:103`) que tributa por el Capítulo II, Sección I de la
LISR (Art. 100–110). A diferencia de PM, **NO usa coeficiente de utilidad**: la base
del ISR provisional es **utilidad real en flujo de efectivo** —ingresos efectivamente
*cobrados* menos deducciones autorizadas efectivamente *pagadas*, acumuladas de enero
al mes, con tarifa Art. 96 elevada al periodo, menos pagos provisionales previos y
retenciones del 10% que le hacen las PM (Art. 106 LISR). Ya implementado en
`src/lib/fiscal/isr-pf.ts` (`calcularIsrProvisionalPf`). El IVA es de flujo (Art. 1-B
/ 5 / 11 / 17 LIVA): se causa al cobro y se acredita al pago. Obligaciones típicas
(`CompanyObligation`, schema:1216): `IVA_MENSUAL` (día 17), `ISR_PROVISIONAL` (día 17),
`DIOT`, y `DECLARACION_ANUAL` PF (abril, `mesVencimiento=4`).

**Riesgos diarios propios de la PF actividad empresarial (lo que el contador revisa a
diario):**

1. **Mezcla personal vs negocio en el banco.** La PF usa frecuentemente la misma
   cuenta para gastos del negocio y consumo personal. Movimientos en `BankTransaction`
   sin CFDI ni conciliar (`status=UNMATCHED`) pueden ser ingresos no facturados (riesgo
   de discrepancia de ingresos del SAT) o gastos personales colados como deducción.
2. **Deducibilidad estricta (requisitos Art. 27).** Pagos en efectivo > $2,000 no
   deducibles; combustible exige medio electrónico a cualquier monto (Art. 27-III). Ya
   cubierto en `audit/checks.ts` (`deduccion.efectivo.limite`,
   `deduccion.combustible.efectivo`) — aplica a 612 vía `aplicabilidad regimenes:"*"`.
3. **Confundir deducciones personales (anual) con deducciones del negocio
   (provisional).** Los CFDI con `usoCfdi` D01–D10 (médicos, colegiaturas, hipoteca,
   funerarios, etc.) son **deducciones personales** que sólo entran en la **anual** con
   topes (Art. 151 LISR), NO en los pagos provisionales ni en el IVA acreditable del
   negocio. `clasificar-cfdi.ts:168` hoy los trata como GASTO deducible — fuente de
   error mensual.
4. **IVA de flujo desfasado.** PUE acreditado/causado sin que el cobro/pago aparezca en
   banco (parcialmente cubierto por `iva.pue.sin_pago`); PPD sin REP; REP con fecha de
   pago inválida (`cfdi.rep.fecha_pago_anterior_factura`).
5. **Retenciones del 10% (Art. 106) y del IVA.** Cuando factura a PM por servicios
   profesionales, la PM le retiene 10% de ISR y 2/3 de IVA. Si el CFDI emitido no trae
   esas retenciones, el provisional/IVA quedan mal y el cliente puede rechazar la
   factura.
6. **Actividad mixta / multi-régimen.** Una PF 612 suele coexistir con 606
   (arrendamiento), 625 (plataformas) o RESICO. `Company.regimenes`
   (`CompanyRegimen[]`, schema:269) captura los demás; mezclar ingresos entre cédulas
   distorsiona la base.
7. **Vigencia de CSD/e.firma y opinión 32-D.** Sin CSD vigente no puede facturar
   (corta el flujo del día); opinión negativa frena cobros con clientes de gobierno.
8. **EFOS (69-B).** Deducir/acreditar de un proveedor listado es improcedente
   (ya cubierto por `/api/cron/efos-screening`).

---

## 2. Tabla priorizada de checks diarios

| # | Check | Qué cacha | Fundamento | Fuente de datos (modelo real) | ¿Automatizable hoy? | Severidad | Frecuencia |
|---|-------|-----------|-----------|-------------------------------|---------------------|-----------|------------|
| 1 | `pf.uso_cfdi.deduccion_personal_como_gasto` | EGRESO con `usoCfdi` D01–D10 (deducción **personal**) clasificado/usado como gasto del negocio o con IVA acreditado | LISR 151 (vs 25/27) | `Invoice.usoCfdi`, `Invoice.tipo=EGRESO`, `Invoice.naturaleza`, `InvoiceTax(IVA)` | **Sí** | warn | Diaria |
| 2 | `pf.banco.ingreso_no_facturado` | Depósito (`CREDITO`) en banco sin CFDI de ingreso conciliable (posible ingreso no facturado / mezcla personal) | LISR 102; CFF 28 | `BankTransaction(tipo=CREDITO, status=UNMATCHED)` vs `Invoice(tipo=INGRESO)` | **Parcial** (falta clasificar transferencias propias/personales) | warn | Diaria |
| 3 | `pf.cfdi.emitido_pm_sin_retenciones` | CFDI de **servicios profesionales** emitido a una PM sin retención de ISR 10% ni IVA 2/3 | LISR 106; LIVA 1-A; RMF | `Invoice(tipo=INGRESO)`, `Customer.rfc` (12=PM), `InvoiceTax(retencion=true)` | **Parcial** (falta marcar "servicio profesional" vs empresarial) | warn | Diaria |
| 4 | `pf.csd.por_vencer` / `pf.efirma.por_vencer` | CSD o e.firma vencido/por vencer → no puede timbrar / declarar | CFF 17-D, 29 | `Company.csdVigencia`, `Company.fielVigencia` | **Sí** | error/warn | Diaria |
| 5 | `pf.ppd.sin_rep` | INGRESO `metodoPago=PPD` cobrado (conciliado en banco) sin complemento de pago emitido | CFF 29-A; LIVA 1-B | `Invoice(metodoPago=PPD)`, `PagoDoctoRelacionado`, `BankTransaction` | **Parcial** (depende de conciliación activa) | warn | Diaria |
| 6 | `deduccion.efectivo.limite` *(existe)* | Pago en efectivo > $2,000 no deducible | LISR 27-III | `Invoice.formaPago="01"`, `total` | **Sí** (ya en `checks.ts`) | warn | Diaria |
| 7 | `deduccion.combustible.efectivo` *(existe)* | Combustible en efectivo | LISR 27-III | `InvoiceItem.claveProdServ 1510…`, `formaPago` | **Sí** (ya en `checks.ts`) | error | Diaria |
| 8 | `iva.pue.sin_pago` *(existe)* | PUE con IVA acreditado sin pago conciliado | LIVA 5-I | `Invoice` + `pagosConciliadosPorInvoice` | **Sí** (ya en `service.ts`) | warn | Diaria |
| 9 | `cfdi.rep.fecha_pago_anterior_factura` *(existe)* | REP con FechaPago previa a la factura → IVA en mes equivocado | CFF 29-A; LIVA 17 | `PagoDoctoRelacionado.fechaPago` | **Sí** (ya) | warn | Diaria |
| 10 | `cfdi.posible_duplicado` *(existe)* | CFDI I/E casi idénticos mismo día | CFF 29-A | `Invoice` agrupado | **Sí** (ya) | warn | Diaria |
| 11 | `banco.movimientos_desactualizados` *(existe)* | Cuenta sin movimientos > 14 días | CFF 28 | `BankTransaction._max(fecha)` | **Sí** (ya) | warn | Diaria |
| 12 | `declaraciones.faltantes` *(existe)* | Acuses faltantes rompen el arrastre (provisional acumulado, saldo a favor IVA) | LISR 14/106 | `cobertura-declaraciones` | **Sí** (ya) | warn | Diaria |
| 13 | `efos.contraparte.definitivo` *(existe)* | Proveedor/cliente en lista 69-B | CFF 69-B | `Customer.rfc` vs lista | **Sí** (cron aparte) | error | Diaria |
| 14 | `pf.isr_provisional.ingreso_acumulado_inconsistente` | El cobrado/pagado acumulado del periodo abierto no cuadra con CFDIs vivos (base del provisional incompleta) | LISR 106 | `Invoice` cobrado vs `BankTransaction`; `calcularIsrProvisionalPf` | **No** (falta motor de flujo acumulado materializado a diario) | info | Diaria |
| 15 | `pf.cfdi_emitido.sin_conciliar_cobro` | Ingreso PUE emitido hace > N días sin depósito conciliado (cuenta por cobrar / posible cancelación olvidada) | LISR 102 | `Invoice(INGRESO)` vs `BankTransaction` | **Parcial** | info | Diaria |

Los checks 6–13 ya existen y aplican a 612 sin cambios (su `aplicabilidad` es
`regimenes:"*"`); se listan para mostrar cobertura. Los nuevos prioritarios son 1–5.

---

## 3. Top checks automatizables — pseudocódigo vs modelos reales

Estilo: checks puros sobre `CfdiNormalizado` van en `audit/checks.ts` (registrados en
`CHECKS`); los que necesitan banco/declaraciones van como `cargar* + auditar*` en su
propio archivo y se enganchan en `runAuditForCompany` (como `pue-pagos`,
`banco-movimientos`).

### Check 1 — Deducción personal (D01–D10) usada como gasto del negocio
`pf.uso_cfdi.deduccion_personal_como_gasto`

Las claves `usoCfdi` D01–D10 son **deducciones personales** (Art. 151 LISR), que sólo
aplican en la **anual** con topes; no son gasto del provisional ni dan IVA acreditable
del negocio. Hoy `clasificar-cfdi.ts:168` las marca GASTO. Requiere exponer `usoCfdi`
en `CfdiNormalizado` (hoy no está, ver §4) o leerlo directo del `Invoice`.

```ts
// audit/checks.ts (requiere usoCfdi en CfdiNormalizado)
const USO_DEDUCCION_PERSONAL = /^D0[1-9]|D10$/;

const deduccionPersonalComoGasto: FiscalCheck = {
  clave: "pf.uso_cfdi.deduccion_personal_como_gasto",
  descripcion: "CFDI con uso de deducción personal (D01–D10) tratado como gasto del negocio",
  aplicabilidad: { regimenes: ["612"], actividades: "*", tipoPersona: "PF" },
  severidad: "warn",
  fundamento: { ley: "LISR", articulo: "151" },
  sugerencia:
    "Las deducciones personales (médicos, colegiaturas, hipoteca…) sólo aplican en la " +
    "declaración ANUAL con sus topes, no en el ISR provisional ni como IVA acreditable " +
    "del negocio. Reclasifícalo (naturaleza SIN_EFECTOS para el negocio) y márcalo como " +
    "deducción personal del ejercicio.",
  evaluar(cfdis) {
    const out: Hallazgo[] = [];
    for (const c of cfdis) {
      if (c.direccion !== "RECIBIDA") continue;
      if (!USO_DEDUCCION_PERSONAL.test((c.usoCfdi ?? "").toUpperCase())) continue;
      out.push({
        checkClave: this.clave, severidad: this.severidad,
        mensaje: `CFDI recibido por ${fmt(c.total)} con uso ${c.usoCfdi} (deducción personal) ` +
                 `tomado como gasto del negocio: no es deducible en el provisional ni acreditable en IVA.`,
        referencias: [c.id], fundamento: this.fundamento, sugerencia: this.sugerencia,
      });
    }
    return out;
  },
};
```
`FiscalHallazgo` emitido: `checkClave="pf.uso_cfdi.deduccion_personal_como_gasto"`,
`severidad="warn"`, `fundamentoLey="LISR"`, `fundamentoArticulo="151"`,
`referencias=[invoice.id]`, `dedupeKey="pf.uso_cfdi…|<invoiceId>"`.

### Check 2 — Depósito bancario sin CFDI de ingreso (ingreso no facturado / mezcla personal)
`pf.banco.ingreso_no_facturado`

Loader nuevo `cargar*` + `auditar*` (estilo `banco-movimientos.ts`). Gated a empresas
que concilian (`reconciliacionActiva`, ya usado en `service.ts:138`) para no levantar
ruido cuando nadie sube banco.

```ts
// audit/banco-ingreso-no-facturado.ts
export async function cargarDepositosSinCfdi(companyId: string, hoy: Date) {
  if (!(await reconciliacionActiva(companyId))) return [];
  const umbral = 5000; // → getRule("pf.banco.umbral_deposito_revisable", ctx)
  const desde = new Date(hoy.getTime() - 60 * DIA_MS);
  return prisma.bankTransaction.findMany({
    where: {
      companyId, tipo: "CREDITO", status: "UNMATCHED",
      invoiceId: null, fecha: { gte: desde }, monto: { gte: umbral },
    },
    select: { id: true, fecha: true, monto: true, descripcion: true, bankAccountId: true },
  });
}

export function auditarDepositosSinCfdi(items): Hallazgo[] {
  return items.map((t) => ({
    checkClave: "pf.banco.ingreso_no_facturado",
    severidad: "warn",
    mensaje: `Depósito por ${fmt(t.monto)} el ${ymd(t.fecha)} ("${t.descripcion}") sin CFDI ` +
             `de ingreso conciliado: posible ingreso no facturado o movimiento personal en la cuenta del negocio.`,
    referencias: [t.id],
    fundamento: { ley: "LISR", articulo: "102" },
    sugerencia:
      "Verifica el depósito: si es ingreso del negocio emite el CFDI y declara el IVA/ISR; " +
      "si es personal (préstamo, traspaso propio), márcalo como IGNORADO/no fiscal para que no " +
      "distorsione la base. La autoridad compara depósitos vs ingresos declarados.",
  }));
}
```
Enganche en `runAuditForCompany`: `...auditarDepositosSinCfdi(await cargarDepositosSinCfdi(companyId, new Date(fecha)))`.
`FiscalHallazgo`: `fundamentoLey="LISR"`, `articulo="102"`, `referencias=[bankTx.id]`.

### Check 3 — CFDI emitido a PM sin retención de ISR/IVA (servicios profesionales)
`pf.cfdi.emitido_pm_sin_retenciones`

```ts
// audit/checks.ts (requiere retencionIsr/retencionIva en CfdiNormalizado, ver §4)
const emitidoPmSinRetenciones: FiscalCheck = {
  clave: "pf.cfdi.emitido_pm_sin_retenciones",
  descripcion: "Servicio profesional facturado a PM sin retención de ISR 10% / IVA 2/3",
  aplicabilidad: { regimenes: ["612"], actividades: "*", tipoPersona: "PF" },
  severidad: "warn",
  fundamento: { ley: "LISR", articulo: "106" }, // + LIVA 1-A-II, RMF
  sugerencia:
    "Si es honorario profesional a una persona moral, el CFDI debe traer retención de ISR " +
    "(10%) y de IVA (2/3 del trasladado). Corrige por sustitución; sin ellas el cliente puede " +
    "rechazarlo y tu cálculo de ISR/IVA del periodo queda mal.",
  evaluar(cfdis) {
    const out: Hallazgo[] = [];
    for (const c of cfdis) {
      if (c.direccion !== "EMITIDA") continue;
      if (c.receptorTipoPersona !== "PM") continue;     // RFC receptor 12 chars
      if (!c.esServicioProfesional) continue;            // por claveProdServ/uso, ver §4
      if (c.retencionIsr && c.retencionIva) continue;
      out.push({
        checkClave: this.clave, severidad: this.severidad,
        mensaje: `CFDI de servicio profesional a PM por ${fmt(c.total)} sin retención ` +
                 `${!c.retencionIsr ? "de ISR 10% " : ""}${!c.retencionIva ? "de IVA 2/3" : ""}.`,
        referencias: [c.id], fundamento: this.fundamento, sugerencia: this.sugerencia,
      });
    }
    return out;
  },
};
```
`FiscalHallazgo`: `fundamentoLey="LISR"`, `articulo="106"`, `referencias=[invoice.id]`.

### Check 4 — CSD / e.firma vencido o por vencer
`pf.csd.por_vencer` / `pf.efirma.por_vencer`

Sin CSD vigente la PF no puede timbrar (rompe el flujo del día); sin e.firma no declara.
Datos ya en `Company.csdVigencia` / `Company.fielVigencia` (schema:136, 142). Loader a
nivel empresa (no por CFDI), estilo agregado.

```ts
// audit/credenciales.ts
export async function auditarVigenciaCredenciales(companyId: string, hoy: Date): Promise<Hallazgo[]> {
  const c = await prisma.company.findUnique({
    where: { id: companyId }, select: { csdVigencia: true, fielVigencia: true },
  });
  const out: Hallazgo[] = [];
  const revisar = (fecha: Date | null, clave: string, label: string, art: string) => {
    if (!fecha) return;
    const dias = Math.floor((fecha.getTime() - hoy.getTime()) / DIA_MS);
    if (dias > 30) return;
    out.push({
      checkClave: clave,
      severidad: dias <= 0 ? "error" : "warn",
      mensaje: dias <= 0
        ? `El ${label} venció el ${ymd(fecha)}: no podrás ${clave.includes("csd") ? "timbrar CFDI" : "presentar declaraciones"}.`
        : `El ${label} vence en ${dias} días (${ymd(fecha)}). Renuévalo en el SAT antes del vencimiento.`,
      referencias: [`${clave}:${ymd(fecha)}`],
      fundamento: { ley: "CFF", articulo: art },
      sugerencia: `Tramita la renovación del ${label} con e.firma en el portal del SAT.`,
    });
  };
  revisar(c?.csdVigencia ?? null, "pf.csd.por_vencer", "Certificado de Sello Digital (CSD)", "29");
  revisar(c?.fielVigencia ?? null, "pf.efirma.por_vencer", "certificado de e.firma", "17-D");
  return out;
}
```
`FiscalHallazgo`: `severidad` error/warn por días; `referencias=["pf.csd.por_vencer:<fecha>"]`
(estable para idempotencia).

### Check 5 — Ingreso PPD cobrado sin REP emitido
`pf.ppd.sin_rep`

```ts
// audit/ppd-sin-rep.ts  (gated a reconciliacionActiva)
export async function cargarPpdSinRep(companyId: string, hoy: Date) {
  if (!(await reconciliacionActiva(companyId))) return [];
  const ppd = await prisma.invoice.findMany({
    where: { companyId, tipo: "INGRESO", status: "STAMPED", metodoPago: "PPD",
             fecha: { lte: hoy }, uuid: { not: null } },
    select: { id: true, uuid: true, total: true, serie: true, folio: true,
              bankTransactions: { where: { status: "MATCHED" }, select: { id: true } } },
  });
  const cobradas = ppd.filter((i) => i.bankTransactions.length > 0); // hay cobro conciliado
  const conRep = await prisma.pagoDoctoRelacionado.findMany({
    where: { parentUuid: { in: cobradas.map((i) => i.uuid!) } }, select: { parentUuid: true },
  });
  const pagados = new Set(conRep.map((r) => r.parentUuid));
  return cobradas.filter((i) => !pagados.has(i.uuid!));
}
```
`auditarPpdSinRep` emite un `FiscalHallazgo` por factura: `checkClave="pf.ppd.sin_rep"`,
`severidad="warn"`, `fundamentoLey="CFF"`, `articulo="29-A"`, `referencias=[invoice.id]`,
con sugerencia de emitir el REP a más tardar el día 5 del mes siguiente al cobro.

---

## 4. Datos que aún no tenemos (o no expuestos a la auditoría)

1. **`usoCfdi` no está en `CfdiNormalizado`.** El campo existe en `Invoice.usoCfdi`
   (schema:515) pero `loadCompanyCfdis` (`service.ts:35`) no lo mapea. Bloquea el
   Check 1. Falta: agregar `usoCfdi` al `select` y a la interfaz `CfdiNormalizado`
   (`audit/types.ts:26`).

2. **Retenciones desglosadas del emitido no expuestas.** `InvoiceTax` ya distingue
   `retencion=true` (schema:752) y `tipo` (IVA/ISR), pero `CfdiNormalizado` sólo expone
   `ivaTrasladado`. Falta: `retencionIsr`/`retencionIva` (boolean o monto) y el RFC del
   receptor (`Customer.rfc`) en el normalizado para el Check 3.

3. **No hay marca "servicio profesional" vs "actividad empresarial".** Para 612 las
   retenciones del 10% sólo aplican a honorarios (Sección, no a venta de mercancía). Se
   puede inferir por `claveProdServ` (familia 80/81 servicios) o por un flag editable;
   hoy no existe. Sin él, Check 3 sólo puede ser `info`/heurístico.

4. **Clasificación "movimiento personal vs negocio" en banco.** `BankTransaction` no
   tiene un flag `esPersonal`/`noFiscal`. Sin él, Check 2 produce falsos positivos con
   traspasos entre cuentas propias y préstamos. Falta: un estado o categoría manual
   (existe `belvoCategory` como pista, schema:843, pero no es fiscal).

5. **Base de flujo acumulado materializada.** `calcularIsrProvisionalPf`
   (`isr-pf.ts`) es pura y necesita `ingresosCobradosAcum` / `deduccionesPagadasAcum`.
   No hay un job que materialice ese acumulado cobrado/pagado por mes para cruzarlo
   contra CFDIs vivos (bloquea Check 14). Falta: agregación de cobrado/pagado por
   periodo persistida o calculada en el cron.

6. **Topes de deducciones personales (Art. 151) no en el rules layer.** El catálogo
   (`rules/catalog.ts`) no tiene `pf.deduccion_personal.tope_uma_anual` ni el 15% de
   ingresos. Necesario para que el Check 1 (y la anual) cite un umbral en vez de sólo
   reclasificar.

7. **Umbral de depósito revisable.** El Check 2 usa `5000` hardcodeado en el ejemplo;
   debe vivir como regla (`pf.banco.umbral_deposito_revisable`) en `catalog.ts` para
   respetar el principio "ningún consumidor hardcodea constantes" de `audit/checks.ts`.

8. **Régimen no se filtra hoy por 612 en el registry.** Los checks existentes usan
   `regimenes:"*"`. Los nuevos (1, 3) deben usar `regimenes:["612"]`; `aplicaAplicabilidad`
   (`run.ts:15`) ya soporta el gate, sólo hay que poblarlo.
