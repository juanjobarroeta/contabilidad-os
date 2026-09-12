# Contador de cabecera — plan de construcción por fases

> Estado: **diseño, sin código.** Este documento fija el orden de construcción
> y el contrato entre fases. Cada fase es un PR que entrega valor por sí solo y
> deja la base de la siguiente. Nada aquí exige Managed Agents ni un runtime
> nuevo: todo corre en la app, con el loop de agente, el medidor de costos y
> el scheduler que ya existen.

## Qué queremos que sea

Hoy el sistema tiene motores buenos y salidas genéricas. El auditor produce
hallazgos con fundamento; la auto-conciliación aplica coincidencias inequívocas;
la mesa deja resolver a mano. Pero lo que ve el cliente son **conteos**: «97
hallazgos», «13,778 posibles duplicados», «3 vencimientos». Un conteo no es
trabajo contable. Un contador de verdad te dice *qué* hizo, *por qué* dejó algo
sin hacer y *qué necesita de ti* para cerrarlo.

Lo que vamos a construir se resume en tres compromisos, que son también los
tres objetivos del agente:

1. **Entregar la contabilidad a tiempo** — cierre, declaraciones, CE, nómina.
2. **Proteger al cliente** — que no pague de más, que no se le pase nada, que
   nada lo exponga (EFOS, 32-D, deducciones sin soporte).
3. **Cumplir la ley** — cada afirmación con fundamento citado del cerebro
   fiscal, nunca de memoria.

Y un principio de ingeniería que atraviesa todo: **cada decisión de un motor
deja rastro legible.** Sin eso no hay historia que enseñar en la mesa, no hay
expediente que valga, y el agente no puede explicar nada.

## Diagnóstico de lo que hay (sept-2026)

| Pieza | Existe | Le falta |
|---|---|---|
| Motores deterministas (auditor 13 checks, auto-conciliar, terminal, REP, traspasos, sin-CFDI, cobertura SAT/declaraciones) | Sí | Ninguno registra *por qué* rechazó lo que rechazó. Sólo queda el resultado final. |
| Narrativa por empresa | `AuditBrief` (una fila, se sobreescribe) | Historia. No sabemos qué se hizo la semana pasada. |
| Conocimiento del cliente («tiene terminal Banorte», «paga a 30 días») | No | Todo. Cada corrida arranca de cero. |
| Salud por empresa | Señales dispersas (`onboarding/estado`, `sat-cobertura`, `cobertura-declaraciones`, columnas de frescura en `Company`) | Un solo cálculo que las junte y diga qué cambió desde ayer. |
| Copiloto (chat) | 47 tools, KB fiscal, escrituras propuestas | Contexto de la empresa más allá de los datos básicos. |
| Rail derecho | Cartas por causa raíz | Sigue siendo una lista de problemas. No dice qué se hizo ni qué se necesita. |
| Digests (push, WhatsApp, cierre) | Sí, sin LLM | Son conteos. |
| Pedirle cosas al cliente | Avisos sueltos (estado de cuenta faltante) | Un objeto «solicitud» con motivo, entidad ligada y seguimiento. |
| Programación | Auditor, auto-conciliar y digests corren **sólo** desde GitHub Actions | Están fuera del scheduler in-app, que es el que se ha probado confiable. |

## Fases

### F0 — Rastro de decisión (`DecisionMotor`)

**Qué.** Tabla append-only donde cada motor deja constancia de lo que decidió
sobre una entidad y por qué, en forma estructurada.

```
DecisionMotor {
  id, companyId, createdAt
  entidad      "BankTransaction" | "Invoice" | "FiscalHallazgo" | "SatSyncRequest" | ...
  entidadId
  motor        "auto-conciliar" | "terminal" | "rep-aplicar" | "traspasos" |
               "sin-cfdi" | "categorizar" | "auditor.<checkClave>" | "sat-sync" | ...
  motorVersion String        // del código, para saber con qué lógica se decidió
  actor        "motor" | "usuario" | "agente"
  actorId?
  accion       "match" | "rechazo" | "ignorar" | "abrir" | "resolver" |
               "categorizar" | "solicitar" | ...
  resultado    Json          // qué quedó (invoiceId, categoría, estado)
  razones      Json          // [{regla, detalle, score?, candidatoId?}] — LEGIBLE
  refs         String[]      // otras entidades tocadas (candidatos considerados)
}
@@index([companyId, entidad, entidadId, createdAt])
```

**Dónde se escribe.** Primero los motores de bancos, que es donde más duele:
`auto-conciliar` (match aplicado *y* los candidatos descartados con su regla:
ambigüedad, tarjeta contraria, fuera de ventana, PUE ya cobrada), `terminal`,
`rep-aplicar`, `traspasos-aplicar`, `movimientos-sin-cfdi`. Después el auditor
(abrir/resolver hallazgo con el check y el fundamento) y el pipeline SAT
(ciclo de vida de `SatSyncRequest`).

`AuditLog` se queda para seguridad. `DecisionMotor` es la línea de tiempo de la
entidad, no del actor.

**Cómo se ve.** `GET /api/bancos/transactions/[id]/historia` devuelve la
línea de tiempo del movimiento. En la mesa, `ResolverMovimiento` gana una
ficha «Historia»: importado del lote X el día Y; el motor consideró 3 facturas
y descartó dos porque el lote es de crédito y las facturas son de débito
(regla `terminal.tarjetaContradice`); conciliado por Juan el día Z. Mismo
componente sirve para una factura o un hallazgo.

**Por qué primero.** Todo lo demás lee de aquí: el expediente cita decisiones,
el agente explica con razones reales, la mesa enseña la lógica. Y es
observabilidad gratis: cuando el motor se equivoque, la razón queda escrita.

### F1 — Expediente por empresa (memoria versionada)

**Qué.** Dos tablas. Una de **hechos** duraderos sobre el cliente y otra de
**notas** cronológicas de trabajo.

```
ExpedienteHecho {
  id, companyId
  clave        String   // "terminal.afiliacion", "cliente.plazo_pago", "cierre.responsable"...
  valor        Json
  fuente       "motor" | "agente" | "usuario"
  evidencia    String[] // DecisionMotor ids, entidades
  vigenteDesde DateTime
  vigenteHasta DateTime?   // null = vigente. Nunca se edita: se cierra y se abre otro.
  confianza    "alta" | "media" | "baja"
}
@@index([companyId, clave, vigenteHasta])

ExpedienteNota {
  id, companyId, createdAt
  autor        "motor" | "agente" | "usuario"
  autorId?
  tipo         "observacion" | "decision" | "pendiente" | "resumen_corrida"
  tema         "conciliacion" | "sat" | "cumplimiento" | "declaraciones" | "ce" | "nomina" | "general"
  titulo       String
  cuerpo       String   @db.Text   // markdown corto
  refs         String[]            // entidades, DecisionMotor ids, hallazgos
  estado       "abierta" | "resuelta"
  resueltaAt?, resueltaPorNotaId?
}
@@index([companyId, createdAt]); @@index([companyId, estado])
```

Los hechos son lo que un contador sabe de su cliente sin abrir nada: qué
terminales tiene y con qué afiliación, qué bancos, quién lleva el cierre, qué
proveedores le facturan en dólares, qué clientes pagan tarde. Versionados por
vigencia: un hecho que cambia no se sobreescribe, se cierra y se abre otro, y
así se puede responder «¿desde cuándo tiene esa terminal?».

Las notas son la bitácora: qué se revisó, qué se decidió, qué quedó pendiente
y por qué. Una nota `pendiente` abierta es un compromiso; la siguiente corrida
la lee antes que nada.

**Quién escribe.** F0 alimenta hechos automáticos (la afiliación de terminal
sale de `tarjetaDeLiquidacion` sobre las descripciones del banco; el banco de
`banco-por-descripcion`). El agente (F3) escribe notas y hechos con
`confianza`. El usuario puede escribir ambos desde la UI.

**Cómo se ve.** Página `/expediente` por empresa: hechos vigentes arriba,
notas abajo con filtro por tema y estado. Y un bloque cacheado en el system
prompt del copiloto: hechos vigentes + últimas N notas + pendientes abiertas.
Con eso el chat deja de ser genérico sin tocar el chat.

### F2 — Salud diaria y delta

**Qué.** Una función pura `evaluarSalud(hechos)` que junta lo que ya se
calcula por separado en un `SaludSnapshot` por empresa y día, y un diff contra
el de ayer.

Dimensiones (cada una con estado `ok | atencion | bloquea | sin_datos` y
detalle):

- **Datos SAT** — cobertura de meses (`sat-cobertura`), solicitudes fallidas,
  `lastAutoSyncAt`, FIEL/CSD vigencia.
- **Cumplimiento** — opinión 32-D, IMSS, CSF: `fetchedAt` y `resultado`.
- **Declaraciones** — obligaciones vencidas sin `TaxDeclaration`, próximas a
  vencer.
- **Contabilidad electrónica** — `ceSatSyncOk`, balanzas por mes, meses sin
  contabilizar (`estado_contable`).
- **Bancos** — movimientos sin conciliar por antigüedad, estados de cuenta
  faltantes, terminales sin liquidación cuadrada.
- **Hallazgos** — abiertos por severidad, nuevos desde ayer.
- **Solicitudes** (F4) — pendientes del cliente y su antigüedad.

El diff produce `deltas`: qué dimensión cambió y en qué sentido. Igual que
`cierre/avance.ts` hace para el cierre, pero para toda la empresa.

**Dónde corre.** Job `salud-diaria` en `cron-scheduler.ts` (no en Actions),
06:00 MX, barato: sólo lecturas. Guarda el snapshot y los deltas. **Este es el
filtro**: sólo las empresas con delta o con pendientes abiertas pasan a F3.

### F3 — El contador razona (agente in-app)

**Qué.** Job `contador-pasada` que, para cada empresa que F2 marcó, corre una
pasada del agente con el loop existente (`tool-executor.ts`) y un system
prompt orientado a los tres objetivos, no a «reporta lo que veas».

**Entrada.** Bloques cacheados: system + expediente (hechos, pendientes,
últimas notas) + salud de hoy con sus deltas. Mensaje de usuario: «Es tu
pasada de hoy. Estos son los cambios. Atiende primero lo que bloquea entregar,
después lo que expone al cliente, después lo que es limpieza».

**Tools.** Las 47 del copiloto, más:

- `leer_historia(entidad, id)` — F0.
- `leer_salud()` — F2.
- `anotar_expediente(tipo, tema, titulo, cuerpo, refs)` y
  `registrar_hecho(clave, valor, evidencia, confianza)` — F1.
- `solicitar_al_cliente(tipo, motivo, refs)` — F4.
- `proponer_*` existentes — escrituras en staging, nunca directas.
- `search_fiscal_knowledge` / `get_articulo` — fundamento obligatorio en
  cualquier afirmación de norma.

**Salida.** No prosa: una nota `resumen_corrida` estructurada
(`{atendido[], pendiente[], solicitado[], escalado[]}`), cada renglón con
`estado`, `causa`, `accion`, `evidencia` y `fundamento` cuando aplica. Es lo
que renderizan el rail, el digest y la página del expediente.

**Eventos.** Además de la pasada diaria, disparadores inmediatos desde los
crons existentes: `SatSyncRequest` → FAILED, `ceSatSyncOk=false`, FIEL a
menos de 30 días, obligación a 48h sin acuse. Cada uno encola una pasada
acotada para esa empresa con el evento como mensaje.

**Costo y escala.** Medido por empresa en `CostEvent` como hoy. Compuerta por
plan: pasada diaria en PRO/DESPACHO, semanal en AUTOMATIZADO, sólo eventos en
ASISTENTE. Con caché de prefijo y el filtro de F2, la pasada marginal queda
en centavos para la mayoría; las de trabajo real, en decenas de centavos. A
2,000 empresas con 10–20 % de deltas diarios, es un costo de producto
defendible. Sin F2 no lo es.

**Escalamiento al operador.** Sólo lo que un humano debe decidir va a
Telegram (bot existente). El resto vive en el expediente y en el rail del
cliente.

### F4 — Solicitudes al cliente (lo que hay que pedir)

**Qué.** Un objeto de primera clase para «necesito algo de ti»:

```
Solicitud {
  id, companyId, createdAt
  tipo        "estado_cuenta_banco" | "estado_cuenta_terminal" | "comprobante" |
              "aclaracion" | "documento_fiscal" | "decision" | ...
  motivo      String   @db.Text   // por qué, en una frase
  refs        String[]            // movimientos, facturas, hallazgos
  periodo?    String              // YYYY-MM
  origen      "motor" | "agente" | "usuario"
  estado      "abierta" | "recibida" | "cancelada"
  canalNotif  String[]            // dónde se avisó
  recibidaAt?, recibidaRef?       // qué se subió y cuándo
}
```

**El caso de la terminal, resuelto.** Hoy cuando la empresa tiene depósitos de
terminal (`tarjetaDeLiquidacion` los reconoce por la afiliación) y no hay
estado de cuenta de la terminal cargado, el sistema no puede cuadrar el lote
contra las ventas ni las comisiones, y nadie se entera hasta que el operador
audita a mano. Con F1+F4:

1. F0/F1 registran el hecho `terminal.afiliacion = {banco, afiliacion,
   tarjetas}` en cuanto aparecen liquidaciones.
2. F2 detecta «mes con liquidaciones de terminal sin estado de cuenta de
   terminal» como dimensión de bancos en `atencion`.
3. F3 (o el propio motor, sin LLM) abre una `Solicitud` tipo
   `estado_cuenta_terminal` con motivo y periodo, ligada a los movimientos.
4. En la mesa, al seleccionar cualquiera de esos movimientos,
   `ResolverMovimiento` muestra la solicitud abierta y ofrece subir el estado
   de cuenta ahí mismo. En WhatsApp, el digest la lleva como pedido concreto.
5. Al recibirse, el motor de terminal cuadra el lote y cierra la solicitud
   con `recibidaRef`.

El mismo mecanismo cubre estados de cuenta bancarios faltantes, comprobantes
de gastos sin CFDI, decisiones del cierre y documentos fiscales que pide el
auditor.

### F5 — Rail derecho v3: trabajo, no problemas

**Qué.** El rail deja de ser una lista de hallazgos y pasa a tres bloques,
alimentados por F1–F4:

1. **Lo que hice** — desde tu última visita: N conciliados, M hallazgos
   cerrados, con enlace a la nota de la corrida.
2. **Lo que necesito de ti** — solicitudes abiertas y decisiones pendientes,
   cada una con su botón al lugar donde se resuelve.
3. **Cómo vamos** — salud por dimensión con el delta de hoy.

Regla dura: **ningún conteo crudo.** Un check que produce miles de renglones
se presenta como *una* revisión con muestra y acción de triage, o no se
presenta. El caso «13,778 posibles duplicados» es además una señal de que el
check está atrapando un patrón legítimo (facturas recurrentes idénticas) y
hay que revisar su heurística; el rail no debe amplificar ruido del auditor.

### F6 — Digests sobre el expediente

Push matutino, WhatsApp y el pase diario del cierre leen del
`resumen_corrida` y de las solicitudes, no de conteos. Un mensaje al día, con
lo que se hizo, lo que se necesita y lo que vence. Los tres formateadores
puros ya existen; cambia la fuente.

## Orden y dependencias

```
F0 rastro ─┬─► F1 expediente ─┬─► F3 agente ─► F5 rail ─► F6 digests
           │                  │
           └─► F2 salud ──────┘
F4 solicitudes: motor puro desde F2; el agente las usa desde F3.
```

F0 y F2 pueden ir en paralelo. F1 depende de F0 para tener evidencia que
citar. F3 no arranca sin F1 y F2. F4 se puede adelantar como motor puro
(terminal, estados de cuenta) en cuanto F2 exista.

Cada fase es un PR con migración, tests de la parte pura y, cuando toca UI,
la ficha o página correspondiente. Ninguna fase rompe lo que hoy corre: los
digests y el rail actuales siguen hasta que F5/F6 los reemplacen.

## Lo que NO vamos a hacer

- Managed Agents en producción. Sirve para prototipar en la consola con 16
  empresas; a 2,000 no da atribución de costo por inquilino ni comparte
  runtime con el copiloto. Queda documentado por si se quiere un prototipo
  rápido, pero el producto vive en la app.
- Un agente que recorra todas las empresas en una sola sesión. Contexto
  finito, empresas saltadas.
- Pasadas por reloj cada N horas. El filtro es el delta y los eventos.
- Escrituras directas del agente. Todo pasa por `proponer_*` o por
  solicitudes; el humano confirma.

## Riesgos conocidos

- **Volumen de `DecisionMotor`.** Registrar cada candidato descartado de cada
  movimiento crece rápido. Mitigación: razones agregadas por movimiento
  (un registro con la lista de descartes), retención de 18 meses, índice por
  entidad.
- **Costo del agente sin filtro.** Si F2 marca demasiado, F3 cuesta. Se mide
  desde el primer día en `CostEvent` con `motivo = "contador-pasada"`.
- **Hechos equivocados.** Un hecho con `confianza baja` del agente puede
  contaminar corridas futuras. El prompt distingue confianza y el usuario
  puede cerrar un hecho desde el expediente.
- **Actions.** Mover auditor, auto-conciliar y digests al scheduler in-app es
  un cambio operativo aparte, pero conviene hacerlo antes de F3 para que la
  cadena completa dependa de un solo reloj.
