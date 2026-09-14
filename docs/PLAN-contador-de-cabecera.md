# Contador de cabecera — plan de construcción por fases

> Estado: **F0–F4 construidas; F5 y F6, diseño.** Este documento fija el orden de construcción
> y el contrato entre fases. Cada fase es un PR que entrega valor por sí solo y
> deja la base de la siguiente. Nada aquí exige Managed Agents ni un runtime
> nuevo: todo corre en la app, con el loop de agente, el medidor de costos y
> el scheduler que ya existen.
>
> **Revisado contra main al 2026-09-14.** Tres cambios recientes tocan este
> plan y quedan incorporados abajo: el copiloto jurídico ya guarda su memoria
> en la base con el patrón que F1 necesita (#1051), la terminal ya tiene
> captura del voucher en caja (#1050), y la conciliación ahora decide el IVA
> acreditable de los PUE (#1060).

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
| Conocimiento del cliente («tiene terminal Banorte», «paga a 30 días») | Sólo en el copiloto jurídico (`JuridicoAsunto`, #1051) | El mismo patrón para la empresa. Cada corrida contable arranca de cero. |
| Salud por empresa | Señales dispersas (`onboarding/estado`, `sat-cobertura`, `cobertura-declaraciones`, columnas de frescura en `Company`) | Un solo cálculo que las junte y diga qué cambió desde ayer. |
| Copiloto (chat) | 47 tools, KB fiscal, escrituras propuestas | Contexto de la empresa más allá de los datos básicos. |
| Rail derecho | Cartas por causa raíz | Sigue siendo una lista de problemas. No dice qué se hizo ni qué se necesita. |
| Digests (push, WhatsApp, cierre) | Sí, sin LLM | Son conteos. |
| Pedirle cosas al cliente | Avisos sueltos (estado de cuenta faltante); captura de voucher en caja para hospital (#1050) | Un objeto «solicitud» con motivo, entidad ligada y seguimiento. |
| Programación | Auditor, auto-conciliar y digests corren **sólo** desde GitHub Actions | Están fuera del scheduler in-app, que es el que se ha probado confiable. |

## Fases

### F0 — Rastro de decisión (`DecisionMotor`) — **construida**

> **Lo que quedó.** `prisma/schema.prisma` (modelo `DecisionMotor`, migración
> `20260924_decision_motor_salud`), `src/lib/decisiones.ts` (escritura
> best-effort, acotado de razones, dedupe por huella, `historiaDeEntidad`),
> `src/lib/bancos/decision-conciliacion.ts` (el razonamiento de la
> auto-conciliación en palabras, PURO), `auto-conciliar.ts` instrumentado sin
> tocar el score, `GET /api/bancos/transactions/[txId]/historia` y la ficha
> «Historia» de la mesa.
>
> **Lo que falta.** Los demás motores: `terminal`, `rep-aplicar`,
> `traspasos-aplicar`, `movimientos-sin-cfdi`, el auditor y el pipeline SAT.
> El módulo genérico ya está, así que instrumentar cada uno es sumarle su
> función de razones.
>
> **Una cosa que el diseño no preveía.** Un rechazo se vuelve a decidir
> idéntico en CADA corrida diaria, así que sin candado el rastro crecería
> escribiendo lo mismo para siempre. Se resolvió con `huella` (FNV-1a del
> razonamiento) + la marca `repetible`: se escribe la primera vez y cuando el
> razonamiento cambia, no cuando el motor vuelve a pasar.


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

**La evidencia ya existe.** En agosto la conciliación automática casó un
traspaso de $30,000 con la factura de un paciente porque emparejó por monto y
fecha, y ese error bloqueó al depósito que sí le tocaba (#1050). Nadie lo vio
hasta que se reconstruyó el mes en Excel. Con rastro, ese match habría quedado
escrito como «candidato único por monto, sin contraparte» y habría sido
revisable el mismo día. La lección del voucher aplica al rastro: el orden de
las señales va en `razones` (titular de la tarjeta antes que importe), no
sólo el score final.

**Y ahora pesa más.** Desde #1060 la conciliación decide el IVA acreditable de
los gastos PUE (`lib/fiscal/iva-pue-flujo`): un match equivocado ya no es
sólo un renglón mal cuadrado, cambia la cifra de la declaración. Un
`DecisionMotor` de conciliación debe poder responder «¿qué IVA movió esto?».

### F1 — Expediente por empresa (memoria versionada) — **construida**

> **Lo que quedó.** `ExpedienteHecho` + `ExpedienteNota` (migración
> `20260925_expediente_empresa`), `src/lib/expediente/claves.ts` (sin Node),
> `hechos.ts` (versionado por vigencia, con `decidirEscritura` PURA),
> `notas.ts`, `prompt.ts` (el bloque del system prompt, PURO), `cargar.ts`,
> `tools.ts` (definiciones sin Prisma) y `ejecutar.ts`. Cuatro herramientas
> nuevas del copiloto —`registrar_hecho`, `anotar_expediente`,
> `consultar_expediente`, `cerrar_pendiente`—, el bloque enganchado en
> `/api/ai/chat` después del breakpoint de caché, las rutas
> `/api/expediente*` y la página `/expediente` en la sidebar.
>
> **La regla que gobierna el módulo.** Un hecho NO se edita: se cierra y se
> abre otro. Sobreescribir era más corto y borraba la única respuesta a «¿desde
> cuándo?» — que es justo la pregunta que aparece cuando un cargo no cuadra con
> el contrato.
>
> **Quién puede pisar a quién.** Lo que una persona verifica en `/expediente`
> queda intocable para los motores y para el agente. El modelo NUNCA escribe
> con fuente «usuario», ni siquiera cuando la conversación la lleva una
> persona: quien escribe la fila es el modelo interpretando lo que le dijeron,
> y esa interpretación no puede pisar un dato confirmado a mano.
>
> **Lo que falta.** Los hechos automáticos desde los motores (afiliación de
> terminal desde `tarjetaDeLiquidacion`, banco desde `banco-por-descripcion`):
> el módulo ya los acepta, falta llamarlo desde cada motor. Y la nota
> `resumen_corrida`, que la escribe F3.


**El patrón ya está en la casa.** El copiloto jurídico dejó de recordar desde
el chat: `JuridicoAsunto` + `JuridicoParte` viven en la base, el modelo los
registra con herramientas (`registrar_partes`, `actualizar_asunto`,
`consultar_asunto`), el bloque «Asunto» va en el system prompt y se refresca
dentro del mismo turno cuando el modelo escribe algo, y lo `verificado` a
mano nunca se pisa (#1051, `src/lib/juridico/asuntos.ts`). F1 es ese mismo
patrón para la empresa: mismas convenciones (`fuente`, `verificado`, bloque
`bloqueExpedienteParaPrompt`, refresco intra-turno), otra entidad.

Nota de nombres: `JuridicoAsunto.expediente` es el número de expediente
judicial. Aquí «expediente» es el legajo contable de la empresa. Son cosas
distintas y conviene que los modelos lleven prefijo (`ExpedienteHecho`,
`ExpedienteNota`) para que no se confundan en el schema.

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
  verificado   Boolean  @default(false)  // confirmado por una persona; el motor y el agente no lo pisan
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

### F2 — Salud diaria y delta — **construida**

> **Lo que quedó.** `src/lib/salud/claves.ts` (sin Node, para que el cliente
> las importe), `evaluar.ts` (PURO: ocho dimensiones, diff, ranking y el filtro
> `requiereAtencion`), `hechos.ts` (el cargador con Prisma), `snapshot.ts`
> (`correrSaludDiaria`, upsert por `(companyId, dia)`), la ruta
> `/api/cron/salud-diaria` y el job en `cron-scheduler.ts`.
>
> **Lo que falta.** La dimensión de **solicitudes** llega con F4 (aún no hay
> tabla que contar), y la UI que enseña la foto llega con F5. El snapshot ya
> se guarda desde hoy: cuando exista el rail, tendrá historia que enseñar.
>
> **Decisión que vale la pena recordar.** El diff NO avisa de un problema que
> sigue igual que ayer. Es la regla del pase del cierre y es la que separa este
> trabajo del rail actual, que repite «13,778 posibles duplicados» todos los
> días hasta que se aprende a ignorarlo.


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
- **IVA en flujo** — gastos PUE del periodo sin pago conciliado (IVA que NO
  se acreditó) y empresas en modo `SUPUESTO_PAGADO` porque no concilian
  banco (#1060). Es la dimensión que conecta bancos con la declaración.
- **Hallazgos** — abiertos por severidad, nuevos desde ayer.
- **Solicitudes** (F4) — pendientes del cliente y su antigüedad.

El diff produce `deltas`: qué dimensión cambió y en qué sentido. Igual que
`cierre/avance.ts` hace para el cierre, pero para toda la empresa.

**Dónde corre.** Job `salud-diaria` en `cron-scheduler.ts` (no en Actions),
06:00 MX, barato: sólo lecturas. Guarda el snapshot y los deltas. **Este es el
filtro**: sólo las empresas con delta o con pendientes abiertas pasan a F3.

### F3 — El contador razona (agente in-app) — **construida**

> **Lo que quedó.** `src/lib/contador/claves.ts` (sin Node: cadencia por plan,
> forma del resumen, `tocaHoy`), `prompt.ts` PURO (el system prompt por
> objetivos, el mensaje de la pasada y el normalizador de la salida),
> `herramientas.ts` + `ejecutar.ts` (`leer_salud`, `leer_historia`,
> `cerrar_pasada`), `pasada.ts` (el bucle, el filtro y la guardia de
> presupuesto), la ruta `/api/cron/contador-pasada` y el job en
> `cron-scheduler.ts` a las 07:00 MX — después de la salud, porque lee su foto.
>
> **Cambio contra el diseño: la salida es una HERRAMIENTA, no texto.** El plan
> decía «una nota `resumen_corrida` estructurada»; parsear prosa para obtenerla
> es frágil y falla justo cuando el modelo tiene más que decir. El cierre es
> ahora la herramienta `cerrar_pasada` con el esquema, y el bucle termina
> cuando la llama. Un renglón sin causa o sin acción se descarta al
> normalizar: nombrar un problema sin su porqué es el ruido que este trabajo
> existe para eliminar.
>
> **El presupuesto se mira antes de invocar al modelo.** Una pasada automática
> nunca debe ser lo que vacía el tope de IA del cliente: quien paga el copiloto
> es él, y quedarse sin chat porque un cron gastó su mes es indefendible.
>
> **Lo que falta.** Los **eventos** (disparadores inmediatos desde los crons:
> `SatSyncRequest` FAILED, `ceSatSyncOk=false`, e.firma a menos de 30 días) y
> el **escalamiento al operador** por Telegram. El renglón `escalado` ya existe
> y ya sale primero en el resumen; falta el canal que lo saque de la app.


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

### F4 — Solicitudes al cliente (lo que hay que pedir) — **construida**

> **Lo que quedó.** El modelo `Solicitud` (migración `20260926_solicitudes`),
> `src/lib/solicitudes/claves.ts` (sin Node: cada tipo con su *qué pedir* y su
> *para qué*), `registro.ts` (abrir idempotente por `dedupeKey`, recibir,
> cancelar), `terminal.ts` (el motor que pide), `tools.ts` + `ejecutar.ts` (las
> herramientas `solicitar_al_cliente` y `consultar_solicitudes`),
> `src/lib/bancos/terminal-faltantes.ts` PURO, las rutas `/api/solicitudes*`,
> la ficha «Falta para poder cuadrar esto» en la mesa y la dimensión
> `solicitudes` de F2, que quedaba pendiente.
>
> **El caso de la terminal, cerrado.** El motor agrupa las liquidaciones por
> mes Y por afiliación —dos terminales son dos pedidos, y un aviso a nivel
> empresa ocultaría la segunda—, excluye el mes en curso (el adquirente no lo
> ha cerrado: pedir lo imposible enseña a ignorar los pedidos) y abre la
> solicitud UNA VEZ. Corre dentro de la pasada diaria de salud, antes de medir,
> para que el pedido aparezca en la foto del mismo día.
>
> **Lo que NO hace.** No hay parser de estados de cuenta de terminal: recibir la
> solicitud registra qué llegó (`recibidaRef`), no lo procesa. Y el
> `voucher_terminal` tiene su tipo y su ficha pero todavía no hay motor que lo
> abra: eso entra cuando la captura en caja (#1050) se conecte con esto.
>
> **Una decisión que vale la pena recordar.** Una solicitud cancelada NO se
> reabre. Cancelar es la decisión de una persona («ese mes no lleva terminal»)
> y el motor no debe desautorizarla cada mañana.


**Qué.** Un objeto de primera clase para «necesito algo de ti»:

```
Solicitud {
  id, companyId, createdAt
  tipo        "estado_cuenta_banco" | "estado_cuenta_terminal" | "voucher_terminal" |
              "comprobante" | "aclaracion" | "documento_fiscal" | "decision" | ...
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
audita a mano. Desde #1050 hay una segunda fuente, mejor que el estado de
cuenta: el voucher fotografiado en caja (`src/lib/hospital/voucher.ts`,
`HospCobro`), que dice a quién corresponde cada deslizada en el único momento
en que alguien lo sabe. Nada se aplica solo; la cajera confirma. Con F1+F4:

1. F0/F1 registran el hecho `terminal.afiliacion = {banco, afiliacion,
   tarjetas}` en cuanto aparecen liquidaciones.
2. F2 detecta dos cosas: «mes con liquidaciones de terminal sin estado de
   cuenta de terminal» y, donde exista captura en caja, «lote con deslizadas
   sin voucher registrado». Ambas como dimensión de bancos en `atencion`.
3. F3 (o el propio motor, sin LLM) abre la `Solicitud` que corresponde:
   `voucher_terminal` para los cobros del día que faltan (la fuente primaria,
   pedida a la caja) y `estado_cuenta_terminal` para el cuadre mensual del
   lote (la fuente de respaldo). Motivo, periodo y movimientos ligados.
4. En la mesa, al seleccionar cualquiera de esos movimientos,
   `ResolverMovimiento` muestra la solicitud abierta y ofrece resolverla ahí
   mismo: subir el estado de cuenta, o abrir la lectura de voucher. En
   WhatsApp, el digest la lleva como pedido concreto.
5. Al recibirse, el motor de terminal cuadra el lote y cierra la solicitud
   con `recibidaRef`. Cada cuadre deja su `DecisionMotor` con el orden de
   señales que #1050 fijó: titular de la tarjeta primero, importe después.

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

F0, F1, F2, F3 y F4 ya están. F1 dependía de F0 para tener evidencia que
citar; F4 se adelantó como motor puro (terminal) en cuanto F2 existió y F3
ya lo usa. Faltan F5 (rail) y F6 (digests), que leen de lo construido.

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
