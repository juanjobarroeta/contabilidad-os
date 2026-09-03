# Topes y medición de IA

_Última actualización: 2026-09-03._

## Por qué

Antes sólo el chat y WhatsApp tenían tope, y cada uno el suyo. Leer una CSF, un
acuse, un estado de cuenta o un documento de empleado, categorizar movimientos,
la síntesis del auditor y el análisis de crédito gastaban modelo sin límite y
varios ni siquiera pedían pertenecer a la empresa. Un usuario en prueba podía
usar el copiloto como un Claude gratis y costar más de lo que paga.

## Una puerta: `asegurarUsoIA` (src/lib/ai/guardia.ts)

Todo endpoint que llama al modelo la invoca ANTES. Tres sumas sobre `CostEvent`:

| Tope | Ámbito | Valor (src/lib/planes.ts) |
|---|---|---|
| Techo mensual de la empresa, todas las funciones | por `companyId`, categorías `LLM` + `OPENAI` | ASISTENTE 5 · AUTOMATIZADO 10 · PRO 20 · DESPACHO 40 USD, **por el tier propio** (sin heredar DESPACHO) **+ extra del mes** (`AiCreditGrant`) |
| Techo mensual si el dueño está en prueba | idem | `IA_USD_MENSUAL_PRUEBA` = 3 USD |
| Gasto sin empresa (onboarding) | por `userId` con `companyId = null` | `IA_USD_MENSUAL_SIN_EMPRESA` = 2 USD |
| Operaciones diarias por usuario | por `userId`, todas las funciones | `IA_OPERACIONES_DIARIAS_USUARIO` = 150 |

Siguen vigentes: el tope diario de mensajes del chat por usuario y los topes de
WhatsApp (mensajes/día y USD/mes por empresa). El chat re-evalúa la guardia en
cada ronda de herramientas y **espera** el registro del costo de la ronda, así
un turno no se pasa del techo.

Respuesta al negar: `429` con `codigo: IA_TOPE_EMPRESA | IA_TOPE_USUARIO_DIA |
IA_TOPE_SIN_EMPRESA` y mensaje en español. La guardia nunca lanza: si la DB
falla, permite y lo deja en consola (es un tope de costo, no de seguridad).

## Atribución

`CostEvent` ahora lleva `userId`. `meteredCreate`/`recordLlmCost` reciben
`{ companyId, userId, subtipo }`. Regla: **siempre que se conozcan, pasarlos**;
un evento sin atribución es gasto que ningún tope ve. También se miden Whisper
(por segundos estimados del audio) y los embeddings (tokens de la API) como
categoría `OPENAI`. El costo del chat incluye los tokens de caché (escritura
1.25×, lectura 0.1× del precio de entrada).

## Endpoints cerrados en este cambio

| Endpoint | Antes | Ahora |
|---|---|---|
| `POST /api/ai/chat` | historial sin tope; sin caché | cuerpo ≤ 200 KB, últimos 40 mensajes, sólo texto/tools (sin imágenes); system prompt con `cache_control`; guardia por ronda |
| `POST /api/onboarding/parse-csf`, `parse-document` | sólo sesión | guardia por usuario (sin empresa) |
| `POST /api/nomina/parse-employee-docs`, `POST /api/bancos/parse-pdf` | sólo sesión | `companyId` opcional en el form → membresía no-VIEWER + tope de empresa; sin él, tope por usuario |
| `POST /api/nomina/sua-reconciliation` | cualquier miembro | no-VIEWER + guardia |
| `GET /api/bancos/sugerencias?llm=1` | una llamada por movimiento, sin tope, VIEWER incluido | sólo no-VIEWER, máx. 25 llamadas por petición, guardia |
| `POST /api/hallazgos/run` | síntesis siempre | síntesis sólo si hay tope disponible (`sintesis: "omitida_por_tope"`) |
| WhatsApp notas de voz | saltaban el limitador | mismo limitador que texto/documentos + guardia |

Ambos system prompts (chat y WhatsApp) llevan ahora un bloque **Alcance** que
declina peticiones fuera de contabilidad/fiscal de la empresa.

## Uso extra (venta)

- Paquete: `IA_PAQUETE_EXTRA_USD` (10 USD de uso) para **una empresa** en el
  **mes en curso**; no rueda al siguiente.
- Compra: `POST /api/billing/ia-extra { companyId }` (OWNER/ADMIN) → Stripe
  Checkout `mode=payment` con `STRIPE_PRICE_IA_EXTRA`. El webhook, al ver
  `checkout.session.completed` con `metadata.tipo = "ia_extra"` y
  `payment_status = "paid"`, crea `AiCreditGrant` (idempotente por
  `stripeSessionId`).
- Cortesía/ajuste del operador: `POST /api/admin/ia-credito { companyId, usd, nota }`.
- El cliente lo ve en Configuración → Facturación → «Uso de este mes»: barra
  por empresa, extra incluido y botón «Ampliar límite».

Precio de venta: lo define el Price en Stripe (sugerido $299 MXN por 10 USD de
costo). Si cambias `IA_PAQUETE_EXTRA_USD`, cambia también el Price.

## Pendiente / decisiones de producto

- Modelo del copiloto: sigue en Fable 5 (`AI_CHAT_MODEL`). Con caché el costo
  de entrada baja mucho; si aun así pesa, `AI_CHAT_MODEL=claude-sonnet-4-5`.
- `SUBSCRIPTION_ENFORCEMENT_ENABLED` sigue apagado: una cuenta vencida conserva
  acceso (y su tope de IA). Encenderlo es decisión de negocio.
- Los números de los topes son perillas: revisarlos con el gasto real de
  /rentabilidad tras un mes.
