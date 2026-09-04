# Módulo HOSPITAL — hospital privado

**Qué es:** el vertical para hospitales privados. Primer cliente: **Haltus
Hope** (propuesta de agosto 2026, `Haltus.pdf`; sustituye a Virtus). Sigue el
patrón de apps satélite de
[INTEGRATION-GUIDE-SATELLITE-APPS.md](./INTEGRATION-GUIDE-SATELLITE-APPS.md):
contabilidad-os es el hub (auth, clientes, proveedores, empleados, CFDI,
bancos, conciliación, mayor, impuestos) y el frontend vive en el repo
**`Hospital`** (SPA React/Vite, sin base de datos ni auth propias). Módulo:
`CompanyModule(modulo = HOSPITAL)`; API: `/api/hospital/*` (bearer + CORS).

## La cadena del producto

```
EXPEDIENTE ──▶ CUENTA ──▶ FACTURA ──▶ BANCO ──▶ CONTABILIDAD
lo que ocurrió  lo que se   lo que se   lo que     lo que se declara
                consumió    cobró       entró
    módulo        módulo       hub         hub           hub
```

«Si se registró en el expediente, está en la cuenta. Si está en la cuenta,
ocurrió en el expediente.» Los dos primeros eslabones son de este módulo; los
otros tres ya existen en el hub y NO se duplican: la factura es un `Invoice`
(se emite con `POST /api/facturas`), el cobro es la conciliación bancaria y
el asiento lo hace el motor del hub al timbrar/conciliar. **En v1 el módulo no
postea nada al mayor**: la cuenta del paciente es trabajo en proceso, no un
hecho contable, hasta que se factura.

## Qué es dato del módulo y qué es canónico

| Dato | Dueño | Superficie |
|---|---|---|
| Pacientes, episodios, notas, signos, documentos, cargos (cuenta), traslados | **Este módulo** (`HospPaciente`, `HospEpisodio`, `HospNota`, `HospSignos`, `HospDocumento`, `HospCargo`, `HospTraslado`) | `/api/hospital/pacientes`, `/api/hospital/episodios` |
| Camas, quirófanos, consultorios (censo y agenda) | **Este módulo** (`HospRecurso`, `HospCita`) | `/api/hospital/censo`, `/recursos`, `/citas` |
| Convenios (pagadores), tarifario, cotizaciones | **Este módulo** (`HospPagador`, `HospServicio`, `HospTarifa`, `HospCotizacion`) | `/api/hospital/pagadores`, `/servicios`, `/cotizaciones` |
| Médicos tratantes y honorarios | **Este módulo** (`HospMedico`; el honorario es un `HospCargo` HONORARIO) | `/api/hospital/medicos` |
| Farmacia: insumos, lotes, kardex | **Este módulo** (`HospInsumo`, `HospLote`, `HospMovimientoInsumo`) | `/api/hospital/farmacia/*` |
| Mantenimiento | **Este módulo** (`HospTicket`) | `/api/hospital/mantenimiento` |
| Clientes y proveedores (directorio fiscal) | Hub (`Customer` — el hub guarda la contraparte de TODO CFDI como Customer por RFC; `Supplier` para CLABE/datos de pago) | `/api/hospital/contactos` (derivado de CFDIs), `/api/clientes/[id]/estado-cuenta` |
| Empleados y nómina | Hub (`Employee`, `PayrollRun`) | `/api/hospital/empleados` (roster), `/api/nomina/*` |
| Facturas CFDI | Hub (`Invoice`) | `/api/facturas` |
| Bancos y conciliación | Hub (`BankAccount`/`BankTransaction`) | `/api/bancos/*` |
| Estado de resultados y balance | Hub (CE presentada + libro derivado) | `/api/contabilidad/ce-*` |
| Impuestos del mes | Hub (`computeTaxPosition`, retenciones) | `/api/hospital/fiscal` |

## Modelos (prisma/schema.prisma → "Module: HOSPITAL")

- `HospConfig` — 1:1 por empresa: series de folio (`HOSP`, `COT`, `MANT`),
  días de alerta de caducidad (90), tope de autorización default, IVA default
  de servicios (0.16).
- `HospRecurso` — camas, quirófanos, consultorios y salas (`tipo`, `area`,
  `estado` LIBRE/OCUPADA/LIMPIEZA/FUERA_DE_SERVICIO). `servicioId` = tarifa
  que se carga sola por noche (cama) u hora (quirófano).
- `HospPaciente` — identificación + datos clínicos de base. `customerId` =
  receptor fiscal por default (puede ser otra persona); `pagadorId` =
  convenio por default.
- `HospPagador` — el convenio: tipo (ASEGURADORA/EMPRESA/PARTICULAR/
  GOBIERNO), `customerId` (RFC al que se factura la parte del pagador),
  deducible, coaseguro, plazo, tope de autorización, vigencia.
- `HospServicio` + `HospTarifa` — catálogo con precio de lista y precio por
  pagador. `ivaTasa`: null = exento (honorarios, Art. 15-XIV LIVA), 0 = tasa
  0 % (medicinas de patente, Art. 2-A), 0.16 = gravado (hospitalización,
  quirófano, estudios).
- `HospMedico` — tratante; `supplierId` cuando factura al hospital
  (dispersión de honorarios), `employeeId` si está en nómina.
- `HospEpisodio` — el ingreso: folio `HOSP-2026-0418`, tipo, estado
  (PROGRAMADO → EN_VALORACION → PREOPERATORIO → EN_QUIROFANO →
  POSTOPERATORIO → HOSPITALIZADO → ALTA; CANCELADO), cama actual, médico,
  pagador, receptor fiscal, diagnóstico CIE-10, cotización de origen.
- `HospTraslado` — bitácora de camas (INGRESO/TRASLADO/ALTA) con los nombres
  congelados como texto.
- `HospNota` — **inmutable** (NOM-004-SSA3-2012): nunca se edita ni borra;
  una corrección es una nota nueva con `reemplazaId`. `cargoId` liga la nota
  al cargo que generó (MEDICAMENTO_APLICADO → cargo de farmacia).
- `HospSignos` — una toma por renglón (TA, FC, FR, temperatura, SpO₂,
  glucosa, peso, talla, dolor).
- `HospDocumento` — consentimientos, identificación, póliza, carta de
  autorización, nota de egreso… `estado` PENDIENTE/RECIBIDO/FIRMADO; los
  requeridos en PENDIENTE son la lista de «Pendientes» del expediente. El
  archivo (`Bytes`) es opcional en v1.
- `HospCargo` — renglón de la cuenta. `origen` dice quién lo generó
  (EXPEDIENTE, ESTANCIA, FARMACIA, COTIZACION, MANUAL); `importe` = cantidad
  × precio SIN IVA; `ivaTasa` null = exento; `invoiceId` cuando ya se
  facturó; `cancelado` en vez de borrar.
- `HospCita` — agenda por recurso; el hub rechaza empalmes (409).
- `HospCotizacion` + `HospCotizacionPartida` — con el tarifario del pagador;
  «convertir» crea el episodio con sus cargos (origen COTIZACION).
- `HospInsumo`, `HospLote`, `HospMovimientoInsumo` — una fila por LOTE con
  caducidad; kardex con signo; idempotente por (insumo, CFDI, tipo) cuando
  nace de una factura.
- `HospTicket` — mantenimiento con prioridad, responsable y preventivos.
- `CompanyMember.hospitalPaginas` — rejilla de páginas visibles del satélite
  (`[]` = todas), mismo contrato que `automotrizPaginas`.

## Lo que se deriva de los datos fiscales (sin captura)

1. **Directorio.** Clientes y proveedores salen de los CFDIs: INGRESO →
   cliente, EGRESO → proveedor (mismo criterio que `automotriz/contactos`).
   Los convenios se ligan al `Customer` del pagador (GNP, AXA…) para que la
   cuenta sepa a qué RFC se factura y la cartera se lea por pagador.
2. **Cuentas por cobrar y por pagar.** Cartera por contacto con evidencia de
   cobro (conciliación + REPs), antigüedad 0-30/31-60/61-90/90+.
3. **Estado de resultados y balance.** La CE presentada manda para los
   periodos declarados; lo derivado de CFDIs para los que aún no se
   presentan (`/api/contabilidad/ce-estado-resultados`, `ce-balance-general`,
   `ce-serie`). Sin código nuevo en el hub: ya son bearer + CORS.
4. **Inventario de farmacia.** Los CFDIs de compra con conceptos de
   medicamento/material (claves SAT 51xx medicamentos, 42xx equipo y material
   médico, 41xx laboratorio, o descripción que lo delate) dan de alta el
   insumo (`derivadoDeCfdi = true`) y una ENTRADA_COMPRA por línea; los
   CFDIs de venta cuyos conceptos coinciden con un insumo (mismo
   NoIdentificacion o descripción normalizada) dan SALIDA_VENTA. Es «tanto
   como se pueda»: un hospital factura «Medicamentos» en un solo renglón, así
   que la salida derivada es parcial y el lote (caducidad) sólo existe cuando
   farmacia lo captura al recibir. Corre inline al importar y como backfill
   (`POST /api/hospital/farmacia/derivar`, cursor en `BackfillProgreso` job
   `hospital-insumos`).
5. **Honorarios médicos.** El cargo HONORARIO en la cuenta (lo cobrado al
   pagador/paciente) se cruza con los CFDIs EGRESO del `Supplier` del médico
   (factura recibida) y su pago en banco (dispersado).
6. **Impuestos del mes.** IVA a cargo/acreditable e ISR retenido a médicos
   (personas físicas con honorarios) salen del motor fiscal del hub.
7. **Nómina.** Empleados y corridas se leen de `/api/nomina/*` (CORS ya
   abierto para satélites).

## Reglas de negocio que viven en `src/lib/hospital/`

- `folio.ts` — siguiente folio por empresa y serie: `HOSP-2026-0418`
  (año + consecutivo de 4 dígitos, reinicia por año). Transaccional.
- `cuenta.ts` — **función pura** `calcularCuenta(cargos, pagador, config)`:
  agrupa por categoría, calcula IVA por renglón (null = exento), separa los
  HONORARIOS (pasan por la cuenta sin ser ingreso del hospital), y el
  **reparto**: `base = total`; `paciente = min(base, deducible) +
  coaseguroPct × (base − deducible)`; `pagador = base − paciente`; particular
  sin convenio → todo al paciente; `requiereAutorizacion = base > tope`.
- `estancia.ts` — `asegurarCargosEstancia(db, episodioId, hoy)`: para un
  episodio HOSPITALIZACION con cama cuyo recurso tiene `servicioId`, un cargo
  ESTANCIA por noche transcurrida (fecha del cargo = la noche), idempotente,
  con el precio del pagador (`HospTarifa`) o el de lista. Se invoca al leer la
  cuenta/expediente y desde el cron `hospital-estancia`.
- `insumos.ts` — clasificación de conceptos CFDI (`esInsumoHospitalario`),
  normalización de clave/descripción, `derivarInsumosDesdeCfdi` (idempotente),
  `aplicarInsumo` (FEFO: primero el lote que caduca antes; 409 si no alcanza).
- `perfil-contacto.ts` — perfil del cliente/proveedor: facturas con evidencia
  de pago, REPs, saldo, antigüedad, más episodios/pacientes ligados.
- `censo.ts` — KPIs puros (ocupación, ingresos/altas del día, estancia
  promedio, día de estancia de un episodio).

## API (`/api/hospital/*`, bearer + CORS)

Todas: `withAuthz` + `requireMembership(companyId, undefined, req)` +
`requireModule(companyId, "HOSPITAL", req)`; escrituras `requireWriter`.
`companyId` en query (GET) o body (POST/PUT); las rutas `[id]` cargan la fila
y usan su `companyId` (fail-closed: 404 si no existe o es de otra empresa).
Importes como número con 2 decimales; fechas ISO. Errores `{ error }`.

### Configuración, panel y búsqueda
```
GET  /api/hospital/config?companyId=            → HospConfig (o defaults)
PUT  /api/hospital/config                        { companyId, ...campos }
GET  /api/hospital/panel?companyId=              → tablero de dirección
GET  /api/hospital/buscar?companyId=&q=          → { pacientes, episodios, insumos, contactos }
GET  /api/hospital/usuarios?companyId=  · POST · PATCH/DELETE /usuarios/[membershipId]
```
`panel`:
```json
{
  "hoy": "2026-09-03",
  "ocupacion": { "ocupadas": 14, "camas": 18, "pct": 78 },
  "cirugiasHoy": { "total": 6, "enCurso": 2, "programadas": 4 },
  "porCobrar": { "total": 1284300, "masDe30": 312400, "facturas": 41 },
  "efectivo": { "saldoBancos": 2146800, "comprometido": 312600, "libre30": 1834200 },
  "impuestos": { "year": 2026, "month": 8, "ivaCargo": 186420, "ivaAcreditable": 71860,
                 "ivaPorPagar": 114560, "isrRetenidoMedicos": 42900, "fechaLimite": "2026-09-17" },
  "movimientosHoy": [{ "episodioId": "…", "folio": "HOSP-2026-0418", "paciente": "María F. Ortega Ruiz",
                       "area": "Quirófano 2", "estado": "POSTOPERATORIO", "medico": "Dr. Alonso Vega",
                       "cuentaTotal": 50572 }],
  "atencion": [{ "tipo": "LOTE_CADUCA", "titulo": "Propofol caduca en 31 días", "detalle": "lote P-1174 · 9 pz", "href": "/farmacia" }]
}
```

### Directorio y dinero (derivado de CFDIs)
```
GET /api/hospital/contactos?companyId=                       → filas como automotriz/contactos + pagadorId
GET /api/hospital/contactos/[customerId]/perfil?direccion=CLIENTE|PROVEEDOR
GET /api/hospital/contactos/[customerId]/estado-cuenta?direccion=CLIENTE|PROVEEDOR&year=2026
    → estado de cuenta DOCUMENTAL (mismo motor que AutomotrizPro): cargos = facturas
      (INGRESO al cliente / EGRESO del proveedor), abonos = notas de crédito, REP con su
      FechaPago legal, PUE liquidada en su emisión y cobro/pago conciliado en banco que
      excede lo amparado; saldo anterior al ejercicio + saldo corrido; imprimible.
      { contacto, direccion, year, saldoAnterior, movimientos: [{ fecha, tipo:
        FACTURA|NOTA_CREDITO|PAGO_REP|PAGO_PUE|COBRO_BANCO, referencia, invoiceId,
        concepto, cargo, abono, saldo }], resumen: { movimientos, cargos, abonos, saldoFinal } }
GET /api/hospital/cartera?companyId=&lado=COBRAR|PAGAR       → { lado, filas[], totales, aging }
GET /api/hospital/compras?companyId=&anio=&mes=[&q=]         → CFDIs EGRESO del mes con conceptos
GET /api/hospital/empleados?companyId=                       → roster (nómina completa en /api/nomina/*)
GET /api/hospital/fiscal?companyId=&year=&month=             → posición fiscal + checklist + retenciones
```

### Clínico
```
GET  /api/hospital/pacientes?companyId=[&q=&activo=]  · POST  · GET/PATCH /pacientes/[id]
GET  /api/hospital/episodios?companyId=[&estado=ACTIVOS|ALTA|TODOS&q=]
POST /api/hospital/episodios                           { companyId, pacienteId, tipo, recursoId?, medicoId?, pagadorId?, customerId?, diagnosticoCie10?, diagnostico?, procedimiento?, motivo?, cotizacionId?, fechaIngreso? }
GET  /api/hospital/episodios/[id]                      → el expediente completo
PATCH /api/hospital/episodios/[id]                     { action: "estado"|"traslado"|"alta"|"datos"|"cancelar", … }
POST /api/hospital/episodios/[id]/notas                { tipo, texto, fecha?, medicoId?, reemplazaId? }
POST /api/hospital/episodios/[id]/signos               { taSistolica?, taDiastolica?, fc?, fr?, temperatura?, spo2?, glucosa?, peso?, talla?, dolor?, nota?, fecha? }
POST /api/hospital/episodios/[id]/documentos           { tipo, nombre, requerido? }
PATCH /api/hospital/episodios/[id]/documentos/[docId]  { estado, firmadoAt? }
GET  /api/hospital/episodios/[id]/cuenta               → grupos, totales, reparto, facturación, conciliación
POST /api/hospital/episodios/[id]/cargos               { categoria, descripcion, cantidad, precioUnitario, ivaTasa?, servicioId?, medicoId?, fecha? }
DELETE /api/hospital/episodios/[id]/cargos/[cargoId]   { motivo }  (cancela, no borra)
POST /api/hospital/episodios/[id]/aplicar-insumo       { insumoId, loteId?, cantidad, nota?, fecha? }
GET  /api/hospital/censo?companyId=[&area=]            → kpis, camas con su episodio, movimientos del día
GET  /api/hospital/recursos?companyId=[&tipo=] · POST · PATCH /recursos/[id]
GET  /api/hospital/medicos?companyId= · POST · PATCH /medicos/[id]
GET  /api/hospital/medicos/honorarios?companyId=&anio=&mes=
GET  /api/hospital/pagadores?companyId= · POST · PATCH /pagadores/[id]
GET  /api/hospital/servicios?companyId=[&categoria=] · POST · PATCH /servicios/[id] · PUT /servicios/[id]/tarifas
GET  /api/hospital/citas?companyId=&desde=&hasta= · POST (409 si empalma) · PATCH /citas/[id]
GET  /api/hospital/cotizaciones?companyId= · POST · GET/PATCH /cotizaciones/[id] · POST /cotizaciones/[id]/convertir
GET  /api/hospital/mantenimiento?companyId=[&estado=] · POST · PATCH /mantenimiento/[id]
```
`episodios/[id]/cuenta`:
```json
{
  "episodio": { "id": "…", "folio": "HOSP-2026-0418", "paciente": { "id": "…", "nombreCompleto": "…" },
                "pagador": { "id": "…", "nombre": "GNP Seguros", "tipo": "ASEGURADORA" }, "customer": { "id": "…", "razonSocial": "…", "rfc": "…" } },
  "grupos": [{ "categoria": "HABITACION", "titulo": "Hospitalización y quirófano",
               "cargos": [{ "id": "…", "fecha": "…", "descripcion": "Habitación estándar · 13 y 14 ago", "cantidad": 2,
                            "precioUnitario": 3200, "ivaTasa": 0.16, "importe": 6400, "iva": 1024, "total": 7424,
                            "origen": "ESTANCIA", "lote": null, "medico": null, "invoiceId": null, "cancelado": false }],
               "subtotal": 18400, "iva": 2944, "total": 21344 }],
  "totales": { "subtotal": 50572, "iva": 2944, "total": 53516, "honorarios": 26500, "hospital": 27016 },
  "reparto": { "pagador": { "nombre": "GNP Seguros", "deducible": 8500, "coaseguroPct": 0.1, "plazoDias": 45, "topeAutorizacion": 60000 },
               "base": 50572, "deducible": 8500, "coaseguro": 1360, "paciente": 9860, "aseguradora": 40712, "requiereAutorizacion": false },
  "facturacion": { "facturado": 40712, "porFacturar": 9860, "facturas": [{ "id": "…", "uuid": "…", "serie": "A", "folio": "1187", "total": 40712, "receptor": "GNP Seguros", "status": "STAMPED" }] },
  "conciliacion": { "cargosSinNota": 0, "notasSinCargo": 1 }
}
```

### Farmacia
```
GET  /api/hospital/farmacia/insumos?companyId=[&q=&tab=TODOS|BAJO_MINIMO|POR_CADUCAR|CONTROLADOS|SIN_EXISTENCIA]
POST /api/hospital/farmacia/insumos · PATCH /farmacia/insumos/[id]
POST /api/hospital/farmacia/lotes                { companyId, insumoId, lote, caducidad?, cantidad, costoUnitario, invoiceId?, supplierId? }
POST /api/hospital/farmacia/movimientos          { companyId, insumoId, loteId?, tipo: AJUSTE|MERMA|CADUCIDAD|DEVOLUCION, cantidad, motivo }
GET  /api/hospital/farmacia/kardex?companyId=&insumoId=
GET/POST /api/hospital/farmacia/derivar          { companyId }  → backfill desde CFDIs (idempotente, por cursor)
```
`insumos`: `{ kpis: { valorInventario, clavesBajoMinimo, lotesPorCaducar, valorEnRiesgo, diasAlerta }, porTab, insumos: [{ id, clave, nombre, presentacion, unidad, categoria, controlado, minimo, existencia, ultimoCosto, precioVenta, valor, ivaTasa, derivadoDeCfdi, estado: "EN_NIVEL"|"BAJO_MINIMO"|"SIN_EXISTENCIA", lotes: [{ id, lote, caducidad, existencia, costoUnitario, diasParaCaducar, estado: "EN_NIVEL"|"CADUCA"|"CADUCADO" }] }] }`.
`existencia` = Σ `HospMovimientoInsumo.cantidad` del insumo (el kardex es la
verdad); `HospLote.existencia` es el saldo materializado por lote.

### Crons
```
POST /api/cron/hospital-estancia          — cargos de estancia de anoche para todos los episodios hospitalizados
POST /api/cron/hospital-insumos-backfill  — drenado histórico del catálogo/kardex desde CFDIs (cursor)
```

## Satélite `Hospital` (repo aparte)

Rutas ↔ endpoints:

| Ruta | Página | Lee de |
|---|---|---|
| `/panel` | Tablero de dirección | `/api/hospital/panel` |
| `/censo` | Censo y camas | `/censo`, `/recursos` |
| `/agenda` | Agenda por recurso | `/citas`, `/recursos`, `/medicos` |
| `/pacientes`, `/pacientes/:id` | Pacientes y ficha | `/pacientes` |
| `/episodios`, `/episodios/:id` | Expedientes y expediente clínico | `/episodios`, `/episodios/[id]` |
| `/episodios/:id/cuenta` | Cuenta del paciente | `/episodios/[id]/cuenta` |
| `/cuentas` | Cuentas abiertas + cartera por pagador | `/episodios?estado=ACTIVOS`, `/cartera` |
| `/cotizaciones` | Cotizador | `/cotizaciones`, `/servicios` |
| `/convenios` | Convenios y tarifario | `/pagadores`, `/servicios` |
| `/medicos` | Médicos y honorarios | `/medicos`, `/medicos/honorarios` |
| `/farmacia` | Lotes y caducidades, kardex | `/farmacia/*` |
| `/compras` | Compras (CFDIs de egreso) | `/compras` |
| `/clientes`, `/proveedores`, `/contactos/:id` | Directorio | `/contactos`, `/contactos/[id]/perfil`, `/api/clientes/[id]/estado-cuenta` |
| `/bancos` | Bancos (sólo lectura) | `/api/bancos`, `/api/bancos/conciliacion` |
| `/estado-resultados`, `/balance` | Contabilidad | `/api/contabilidad/ce-*` |
| `/nomina` | Nómina | `/api/nomina/*` |
| `/impuestos` | Impuestos del mes | `/api/hospital/fiscal`, `/api/papeles/*` |
| `/mantenimiento` | Tickets | `/mantenimiento` |
| `/alertas` | Requiere atención | `/panel` (`atencion`) |
| `/usuarios`, `/configuracion` | Administración | `/usuarios`, `/config` |

## Alta de una empresa

1. `CompanyModule(companyId, modulo = HOSPITAL)`.
2. Origen del satélite en `API_ALLOWED_ORIGINS` (Railway).
3. `scripts/seed-hospital-demo.ts --company <id>` carga camas, convenios,
   tarifario, médicos y un día de operación de muestra (idempotente).
4. `POST /api/hospital/farmacia/derivar` para poblar farmacia desde el
   archivo de CFDIs.

## Lo que NO hace (por diseño, v1)

- No postea al mayor: la cuenta es WIP; el asiento nace con el CFDI.
- No emite el CFDI desde el módulo: la factura partida (pagador/paciente) se
  arma con los cargos y se timbra con `POST /api/facturas` del hub (fase 2).
- No resguarda el PDF firmado del consentimiento (registra el hecho).
- No expone historial clínico en el portal del paciente (fuera de la
  propuesta: datos sensibles, se decide aparte).
