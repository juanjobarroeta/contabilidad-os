# Compliance diario del PATRÓN (nómina, dimensión 605) — propuesta de checks automatizados

> Extiende el framework `src/lib/fiscal/audit/` (mismo contrato `FiscalCheck` / `Hallazgo`,
> persistencia idempotente en `FiscalHallazgo` vía `runAuditForCompany`).
> Régimen receptor del CFDI de nómina = **605 Sueldos y Salarios e Ingresos Asimilados**
> (`emit-nomina.ts:99` fija `tax_system: "605"`), pero las obligaciones que se revisan
> aquí son las del **patrón/retenedor** (Company), no las del trabajador.

---

## 1. Perfil del patrón + riesgos diarios/periódicos

**Quién es.** Una `Company` con `registroPatronal` (`schema.prisma` Company.registroPatronal,
requisito duro en `emit-nomina.ts:46`) y ≥1 `Employee` activo (`isActive=true`).
El patrón tiene, todos los días, obligaciones que un *administrador de nómina* vigila:

| Obligación | Plazo legal | Disparador diario |
|---|---|---|
| **Alta IMSS** de nuevo trabajador | 5 días hábiles desde el inicio de la relación (`fechaIngreso`) | `Employee` nuevo sin `ImssMovimiento` tipo ALTA presentado |
| **Baja IMSS** | 5 días hábiles desde la separación | `Employee.fechaBaja` puesta sin `ImssMovimiento` BAJA |
| **Modificación de salario / SDI** | 5 días hábiles desde el cambio | `salarioDiarioIntegrado` cambia sin `ImssMovimiento` MODIFICACION_SALARIO |
| **CFDI de nómina timbrado** | a más tardar el día del pago (regla 2.7.5.1 RMF; Art. 27-V / 99-III LISR) | `PayrollRun` pagado sin `Invoice tipo=NOMINA` / sin `PayrollItem.cfdiUuid` |
| **Pago efectivo de la nómina** conciliado | el CFDI debe respaldar un pago real | `Invoice tipo=NOMINA` sin `BankTransaction` MATCHED |
| **Retención y entero de ISR** por salarios | entero a más tardar el 17 del mes siguiente (Art. 96 / 99 LISR) | `TaxDeclaration tipo=RETENCIONES_ISR` faltante vs nómina del mes |
| **Cuotas IMSS / aportaciones INFONAVIT** | IMSS día 17 del mes siguiente; INFONAVIT bimestral (17 del 1er mes del bimestre) | importe patronal calculable, sin pago conciliado |
| **Prima de riesgo de trabajo anual** | declarar en **febrero** (Art. 74 RACERF) con base en la siniestralidad del año anterior | `riesgoPuesto` sin revisión anual; ventana 1–28 feb |
| **Tablas ISR / UMA / salario mínimo vigentes** | UMA y SM cambian 1-feb / 1-ene | `tarifaVerificada=false` (ver `isr.ts:117`), `UMA_EJERCICIO` rebasado |

**Riesgos diarios concretos:**
- **SDI desactualizado.** `salarioDiarioIntegrado` < `salarioDiario` × factor de integración mínimo
  (1.0452 con prestaciones de ley el 1er año) → cuotas IMSS y descuentos INFONAVIT sub-cotizados
  (Art. 27 / 28 LSS). Es el error más frecuente y caro (capitales constitutivos, multas).
- **CFDI de nómina emitido pero sin pago real conciliado** → riesgo de simulación / deducción
  improcedente (Art. 27-V LISR exige que el pago de salarios > tope se haga por transferencia).
- **Empleado pagado por CFDI pero sin alta IMSS** → trabajador sin seguridad social; sanción LSS.
- **Retención ISR del CFDI ≠ tarifa Art. 96** → sub/sobre-retención; el patrón responde por la diferencia.
- **Tarifa/UMA vencida** → todo el cálculo del periodo mal (lo marca `isr.ts` con `tarifaVerificada`).

---

## 2. Tabla priorizada de checks diarios

> Severidad usa la escala del framework (`types.ts`: `info|warn|error`).
> "Automatizable hoy" se juzga contra modelos reales del repo.

| # | Check | Qué cacha | Fundamento | Fuente de datos (modelo real) | ¿Auto hoy? | Sev | Frec |
|---|---|---|---|---|---|---|---|
| N1 | `nomina.cfdi.sin_pago_conciliado` | CFDI de nómina timbrado sin `BankTransaction` MATCHED que cubra el neto | LISR 27-V; 99-III | `Invoice tipo=NOMINA`, `BankTransaction.status/invoiceId/monto` (`conciliacion-pue.ts`) | **sí** | error | diaria |
| N2 | `nomina.imss.alta_vencida` | `Employee` con `fechaIngreso` y CFDI/PayrollItem, sin `ImssMovimiento` ALTA en plazo (5 días hábiles) | LSS 15-I; RACERF 45 | `Employee.fechaIngreso`, `ImssMovimiento` (tipo=ALTA, status) | **parcial** (falta IDSE: solo sabemos lo capturado in-app) | error | diaria |
| N3 | `nomina.imss.baja_vencida` | `Employee.fechaBaja` puesta sin `ImssMovimiento` BAJA presentada en 5 días hábiles | LSS 37; RACERF 57 | `Employee.fechaBaja`, `ImssMovimiento` (tipo=BAJA) | **parcial** (idem IDSE) | error | diaria |
| N4 | `nomina.sdi.desactualizado` | `salarioDiarioIntegrado` nulo o < factor de integración mínimo × `salarioDiario` | LSS 27, 30 | `Employee.salarioDiario`, `salarioDiarioIntegrado` | **sí** | warn | diaria |
| N5 | `nomina.imss.modificacion_sbc_pendiente` | `salarioDiario`/SDI cambió (vs último ALTA/MOD) sin `ImssMovimiento` MODIFICACION_SALARIO | LSS 34; RACERF 53 | `Employee.updatedAt`, `ImssMovimiento.sbcNuevo` | **parcial** (no hay histórico de SBC fuera de ImssMovimiento) | warn | diaria |
| N6 | `nomina.cfdi.faltante_periodo` | `PayrollRun` pagado (status≠DRAFT) sin `Invoice tipo=NOMINA` / `PayrollItem.cfdiUuid` nulo | LISR 27-V, 99-III; RMF 2.7.5.1 | `PayrollRun.status/fechaPago`, `PayrollItem.cfdiUuid`, `Invoice tipo=NOMINA` | **sí** | error | diaria |
| N7 | `nomina.isr.retencion_vs_tarifa` | ISR retenido del CFDI (`Invoice.isrRetenidoNomina` / `PayrollItem.isrRetenido`) ≠ `calcularIsrRetenido()` ± tolerancia | LISR 96 | `PayrollItem`, `Employee.periodicidadPago/salarioDiario`, `isr.ts` | **sí** | warn | diaria |
| N8 | `nomina.isr.tarifa_no_verificada` | El cálculo usó tarifa/subsidio vencido o sin cotejar | LISR 96; LUMA 5 | `calcularIsrRetenido().tarifaVerificada` (`isr.ts:56,117`), `UMA_EJERCICIO` (`constants.ts:9`) | **sí** | warn | diaria |
| N9 | `nomina.retenciones.entero_faltante` | Hubo nómina pagada en el mes M pero falta `TaxDeclaration tipo=RETENCIONES_ISR` periodo M (después del día 17 del mes M+1) | LISR 96 | `PayrollRun.fechaPago`, `TaxDeclaration tipo=RETENCIONES_ISR` | **parcial** (calendario de plazo) | error | diaria |
| N10 | `nomina.infonavit.descuento_sin_credito` | `Employee` con `creditoInfonavit` y `tipoDescuentoInfonavit` pero descuento 0/null (o viceversa: descuento sin crédito) | LFT 110-IV; Ley INFONAVIT 29 | `Employee.creditoInfonavit/tipoDescuentoInfonavit/descuentoInfonavit`, `infonavit.ts` | **sí** | warn | diaria |
| N11 | `nomina.prima_riesgo.declaracion_anual` | En ventana 1–28 feb no se ha revisado/declarado la prima de RT anual | LSS 74; RACERF 32 | `Company.id`, `Employee.riesgoPuesto`, fecha actual | **parcial** (no hay registro de "declaración de prima") | warn | estacional (feb) |
| N12 | `nomina.sbc.sobre_tope_25uma` | `salarioDiarioIntegrado` > 25 UMA → cotización topada; señalar para validar captura | LSS 28 | `Employee.salarioDiarioIntegrado`, `TOPE_SBC_25_UMA` (`constants.ts`) | **sí** | info | diaria |
| N13 | `nomina.empleado.datos_incompletos` | `Employee` activo con `nss`/`curp`/`rfc`/`riesgoPuesto` inválido o faltante (bloquea timbrado/alta) | LSS 15; LISR 99 | `Employee.nss/curp/rfc/riesgoPuesto` | **sí** | warn | diaria |

---

## 3. Top 5 automatizables — pseudocódigo (estilo `audit/checks.ts`)

Estos se implementarían como cargadores `cargar…(companyId)` + funciones puras
`auditar…(): Hallazgo[]`, igual que `banco-movimientos.ts` / `declaraciones-faltantes.ts`,
y se enchufarían en el array de `runAuditForCompany` (`service.ts:181`). Emiten
`FiscalHallazgo` con la misma forma (`checkClave`, `severidad`, `referencias`, `fundamento*`).

### N1 — CFDI de nómina emitido pero sin transferencia bancaria conciliada `(error)`

Reutiliza el patrón exacto de `cargarPueSinPago` + `pagosConciliadosPorInvoice` (`conciliacion-pue.ts`),
gated por `reconciliacionActiva` para no generar falsos positivos en empresas que no concilian.

```ts
// cargador (service-layer)
async function cargarNominaSinPago(companyId, fechaIso) {
  if (!(await reconciliacionActiva(companyId))) return [];      // gate: sin banco, callados
  const mes = rangoMes(fechaIso);
  const nominas = await prisma.invoice.findMany({
    where: { companyId, tipo: "NOMINA", status: "STAMPED",
             canceladaAt: null, fecha: { gte: mes.from, lt: mes.to } },
    select: { id: true, total: true, fecha: true, notas: true },
  });
  const pagado = await pagosConciliadosPorInvoice(nominas.map(n => n.id)); // BankTransaction MATCHED
  return nominas.filter(n => !pagadaCompleta(Math.abs(n.total), pagado.get(n.id) ?? 0));
}

// check puro
evaluar(items) {
  return items.map(n => ({
    checkClave: "nomina.cfdi.sin_pago_conciliado",
    severidad: "error",
    mensaje: `CFDI de nómina por ${fmt(Math.abs(n.total))} (${n.notas ?? n.fecha}) sin transferencia bancaria conciliada: el pago de salarios debe respaldarse con medio electrónico.`,
    referencias: [n.id],
    fundamento: { ley: "LISR", articulo: "27", fraccion: "V" },
    sugerencia: "Concilia la transferencia de la nómina en Bancos. Sin pago real, la deducción del salario es improcedente (Art. 27-V LISR).",
  }));
}
```

> Nota: `Invoice tipo=NOMINA` guarda el neto en `total` con signo
> (`emit-nomina.ts:220`: `total: netoAPagar`, `totalImpuestos: -totalDeducciones`),
> por eso se usa `Math.abs`.

### N2 — Empleado con CFDI de nómina pero posible NO-alta en IMSS `(error / parcial)`

```ts
async function cargarPosibleNoAlta(companyId) {
  const empleados = await prisma.employee.findMany({
    where: { companyId, isActive: true },
    select: { id: true, nombre: true, apellidoPaterno: true, nss: true,
              fechaIngreso: true,
              imssMovimientos: { where: { tipo: "ALTA" }, select: { status: true, filedAt: true } },
              payrollItems: { where: { cfdiUuid: { not: null } }, take: 1, select: { id: true } } },
  });
  const hoy = new Date();
  return empleados.filter(e => {
    const tieneCfdiNomina = e.payrollItems.length > 0;          // ya se le timbró nómina
    const altaPresentada  = e.imssMovimientos.some(m => m.status === "FILED" || m.filedAt);
    const diasHabiles     = diasHabilesDesde(e.fechaIngreso, hoy);
    return tieneCfdiNomina && !altaPresentada && diasHabiles > 5; // pagado pero sin alta en plazo
  });
}

evaluar(items) {
  return items.map(e => ({
    checkClave: "nomina.imss.posible_no_alta",
    severidad: "error",
    mensaje: `${e.nombre} ${e.apellidoPaterno} recibe CFDI de nómina pero no tiene alta IMSS confirmada (ingreso ${iso(e.fechaIngreso)}). El alta vence a los 5 días hábiles.`,
    referencias: [e.id],
    fundamento: { ley: "LSS", articulo: "15", fraccion: "I" },
    sugerencia: "Presenta el alta en IDSE y captura el movimiento (ImssMovimiento ALTA → FILED) o adjunta el acuse. Sin alta, el trabajador queda sin seguridad social y el patrón se expone a capitales constitutivos.",
  }));
}
```

> **Parcial**: solo verificamos lo capturado en `ImssMovimiento`. Sin integración IDSE
> no podemos *confirmar* el alta ante IMSS; el check detecta la *ausencia del registro
> in-app*, que es la señal accionable que un administrador revisa cada mañana.

### N4 — SDI desactualizado / por debajo del mínimo de integración `(warn)`

```ts
const FACTOR_INTEGRACION_MIN = 1.0452; // prestaciones de ley, 1er año (6 días aguinaldo + 25% prima vac. sobre 6 días vac.)

async function cargarSdiDesactualizado(companyId) {
  const empleados = await prisma.employee.findMany({
    where: { companyId, isActive: true },
    select: { id: true, nombre: true, salarioDiario: true, salarioDiarioIntegrado: true },
  });
  return empleados.filter(e => {
    const sdi = e.salarioDiarioIntegrado;
    const minimo = e.salarioDiario * FACTOR_INTEGRACION_MIN;
    return sdi == null || sdi < minimo - 0.01;   // nulo o por debajo del piso legal
  });
}

evaluar(items) {
  return items.map(e => ({
    checkClave: "nomina.sdi.desactualizado",
    severidad: "warn",
    mensaje: e.salarioDiarioIntegrado == null
      ? `${e.nombre}: sin Salario Diario Integrado (SDI). Las cuotas IMSS se están calculando sobre el salario diario sin integrar prestaciones.`
      : `${e.nombre}: SDI ${fmt(e.salarioDiarioIntegrado)} por debajo del mínimo integrado ${fmt(e.salarioDiario * FACTOR_INTEGRACION_MIN)} — riesgo de subcotización IMSS.`,
    referencias: [e.id],
    fundamento: { ley: "LSS", articulo: "27" },
    sugerencia: "Integra el SBC con las prestaciones de ley (aguinaldo, prima vacacional) — factor ≥ 1.0452 el primer año — y presenta la modificación de salario en IMSS.",
  }));
}
```

### N6 — CFDI de nómina faltante para un PayrollRun pagado `(error)`

```ts
async function cargarNominaSinTimbrar(companyId, fechaIso) {
  const mes = rangoMes(fechaIso);
  const runs = await prisma.payrollRun.findMany({
    where: { companyId, status: { not: "DRAFT" }, fechaPago: { gte: mes.from, lt: mes.to } },
    select: { id: true, periodo: true, fechaPago: true,
              items: { select: { id: true, cfdiUuid: true, employeeId: true } } },
  });
  return runs.flatMap(r =>
    r.items.filter(i => !i.cfdiUuid).map(i => ({ runId: r.id, periodo: r.periodo, itemId: i.id })));
}

evaluar(items) {
  // agrega por run para un solo hallazgo legible
  return groupByRun(items).map(g => ({
    checkClave: "nomina.cfdi.faltante_periodo",
    severidad: "error",
    mensaje: `Nómina del periodo ${g.periodo} pagada con ${g.sinTimbrar} recibo(s) sin CFDI timbrado.`,
    referencias: [g.runId],
    fundamento: { ley: "LISR", articulo: "99", fraccion: "III" },
    sugerencia: "Timbra los CFDI de nómina (emit-nomina) a más tardar el día del pago. Sin CFDI, el salario no es deducible (Art. 27-V LISR).",
  }));
}
```

### N7 — Retención ISR del recibo ≠ tarifa Art. 96 `(warn)`

```ts
async function cargarIsrInconsistente(companyId, fechaIso) {
  const mes = rangoMes(fechaIso);
  const items = await prisma.payrollItem.findMany({
    where: { payrollRun: { companyId, status: { not: "DRAFT" }, fechaPago: { gte: mes.from, lt: mes.to } } },
    select: { id: true, totalPercepciones: true, isrRetenido: true,
              payrollRun: { select: { fechaPago: true } },
              employee: { select: { nombre: true, periodicidadPago: true } } },
  });
  const out = [];
  for (const it of items) {
    const calc = calcularIsrRetenido({                              // reusa isr.ts
      baseGravable: it.totalPercepciones,
      periodicidadPago: it.employee.periodicidadPago,
      ejercicio: it.payrollRun.fechaPago.getFullYear(),
      mes: it.payrollRun.fechaPago.getMonth() + 1,
    });
    const dif = Math.abs(calc.isrRetenido - it.isrRetenido);
    if (dif > Math.max(1, it.isrRetenido * 0.02)) out.push({ it, calc, dif });  // > 2% o $1
  }
  return out;
}

evaluar(items) {
  return items.map(({ it, calc, dif }) => ({
    checkClave: "nomina.isr.retencion_vs_tarifa",
    severidad: "warn",
    mensaje: `${it.employee.nombre}: ISR retenido ${fmt(it.isrRetenido)} difiere ${fmt(dif)} del cálculo por tarifa Art. 96 (${fmt(calc.isrRetenido)}).`,
    referencias: [it.id],
    fundamento: { ley: "LISR", articulo: "96" },
    sugerencia: "Revisa la base gravable y el subsidio para el empleo; corrige la retención antes de enterar.",
  }));
}
```

> Acoplar N7 con N8: si `calc.tarifaVerificada === false`, degradar a `info`/anexar nota,
> porque el contraste se hizo contra una tabla no cotejada (`isr.ts:117`).

---

## 4. Datos que aún NO tenemos (límites de automatización)

1. **No hay integración IDSE/IMSS en línea.** El modelo `ImssMovimiento`
   (tipo ALTA/BAJA/MODIFICACION_SALARIO/REINGRESO, `status` PENDING→EXPORTED→FILED→REJECTED,
   `idseConfirmation`) es **captura interna**: nadie confirma contra IMSS que el movimiento
   se presentó. N2/N3/N5 detectan la *ausencia del registro*, no el incumplimiento real
   ante la autoridad. → checks **parciales**. Falta: conector IDSE (o carga del acuse/EMA-EBA).

2. **No hay calendario de días hábiles ni de feriados oficiales.** Los plazos LSS son en
   "días hábiles". Se necesita una tabla de días inhábiles (festivos federales) para que
   N2/N3 no marquen falsos vencimientos. Hoy solo hay fechas naturales en los modelos.

3. **No hay histórico de SBC/SDI.** `Employee.salarioDiarioIntegrado` guarda solo el valor
   actual; los cambios solo quedan registrados si se creó un `ImssMovimiento`. N5 (modificación
   pendiente) no puede comparar contra el SBC realmente comunicado a IMSS sin ese histórico.

4. **Factor de integración no parametrizado.** N4 asume el piso legal de ley (1.0452, 1er año).
   La integración real depende de prestaciones superiores (vales, fondo de ahorro, premios) que
   no están modeladas por empleado → el check solo cacha el *piso*, no la integración exacta.
   No existe regla en la capa `rules`/`getRule` para nómina (los checks actuales toman umbrales
   de ahí); habría que añadir `imss.sdi.factor_integracion_minimo` para no hardcodear.

5. **No hay registro de "declaración de prima de riesgo".** N11 (prima RT anual de febrero) solo
   puede recordar la obligación por ventana de fechas; no hay modelo que marque que se presentó
   ni datos de siniestralidad (accidentes/días subsidiados) para recalcular la prima.

6. **No hay pago de cuotas IMSS/INFONAVIT como entidad propia.** A diferencia de
   `TaxDeclaration tipo=RETENCIONES_ISR` (que sí existe y habilita N9), no hay un modelo para la
   liquidación SUA/EMA ni el pago bimestral INFONAVIT, así que "cuotas pagadas vs calculadas"
   solo es aproximable cruzando `BankTransaction` por descripción/monto (frágil).

7. **`Employee` no almacena el CP/estado del trabajador.** `emit-nomina.ts:103` usa el CP de la
   empresa como placeholder; `claveEntFed` default `"PUE"`. Un check de coherencia de
   `claveEntFed` (para ISN estatal y prima por entidad) tendría baja confianza.
