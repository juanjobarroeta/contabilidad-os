# Perfil Crediticio — Plan de diseño

**Estado:** plan aprobado para construcción por fases · **Dueño:** Juan Barroeta
**Objetivo:** calificar empresas para crédito con los datos verificados que ya tenemos, enriquecidos con IA y señales externas, como (a) activo del producto, (b) pitch de ventas y (c) futura fuente de ingresos por referidos.

---

## 1. La tesis

Tenemos lo que un underwriter de PyMEs necesita y casi nadie más tiene **verificado en origen**:
ingresos timbrados ante el SAT (no auto-reportados), flujo bancario real, nómina/IMSS,
cumplimiento fiscal en vivo y comportamiento de cobranza (complementos de pago). Es el mismo
stack con el que operan Konfío/Credijusto — nosotros lo tenemos como subproducto de la
contabilidad diaria.

El feature: un **Perfil Crediticio por empresa** — score explicable + dossier exportable +
recomendaciones para mejorarlo — que sirve al dueño (saber si califica y qué corregir), al
despacho (calificar su cartera, upsell de asesoría) y a nosotros (diferenciación y, en fase
posterior, referidos a fondeadores).

## 2. Principios de diseño (no negociables)

1. **Núcleo determinista y explicable.** El score lo calcula un motor puro con umbrales
   documentados y pruebas doradas (mismo patrón que el motor fiscal). Un contador debe poder
   defender cada punto del score frente a su cliente o a un banco.
2. **La IA enriquece, nunca decide.** LLM y señales externas producen narrativa, banderas y
   ajustes ACOTADOS (± puntos con tope); jamás mueven el número fuera de sus límites ni
   sustituyen un dato duro.
3. **Jerarquía de evidencia.** Tier 1 = verificado en origen (CFDI, SAT, banco, IMSS).
   Tier 2 = verificado por tercero (Buró, Syntage). Tier 3 = señal blanda (web, redes,
   inferencias de IA). Un Tier 3 nunca contradice a un Tier 1 — sólo agrega o resta dentro
   de su banda y siempre visible como "señal externa".
4. **Consentimiento primero.** Buró exige autorización expresa (Ley SIC); compartir el
   dossier exige acción explícita del dueño. Nada se consulta ni se comparte en silencio.
5. **Costo medido.** Cada consulta con costo (Buró, web search, LLM) se registra en
   `CostEvent` y se gatea por tier — el mismo patrón de Syntage/WhatsApp.
6. **No somos el prestamista.** Análisis informativo y dossiers; ni originación ni promesa
   de crédito (evita territorio SOFOM y expectativas legales). Disclaimer en todo output.

## 3. Las métricas (Fase 0-1 — sólo datos que ya tenemos)

| # | Métrica | Fuente | Qué mide |
|---|---------|--------|----------|
| 1 | Ingresos TTM y tendencia (12-24m) | CFDI ingreso | Capacidad de pago |
| 2 | Crecimiento YoY | CFDI | Trayectoria |
| 3 | Margen bruto aproximado | CFDI ingreso − egreso | Rentabilidad |
| 4 | Flujo neto bancario / ingresos | Movimientos banco | Caja real vs papel |
| 5 | DSO y cartera vencida PPD | Complementos de pago | Calidad de cobranza |
| 6 | Concentración top-5 clientes | CFDI receptores | Riesgo de dependencia |
| 7 | Cumplimiento: opinión 32-D, declaraciones al día | ComplianceSnapshot | Formalidad |
| 8 | Antigüedad del RFC y del historial | CSF / primer CFDI | Madurez |
| 9 | Masa salarial y headcount estable | CFDI nómina / IMSS | Estructura real |
| 10 | Contrapartes en 69-B (EFOS) | Screening existente | Riesgo de red |
| 11 | Estacionalidad / volatilidad de ingresos | CFDI serie mensual | Estabilidad |
| 12 | Carga fiscal pagada (ISR/IVA efectivo) | Declaraciones | Coherencia contable |

Cada métrica reporta: valor, periodo, **completitud del dato** (p. ej. "sólo 7 meses de
historial", "sin banco vinculado") y contribución al score. La completitud produce un grado
de **confiabilidad del score** (alta/media/baja) — un score con datos flacos lo dice de frente.

**Score:** 0-1000 con bandas A (≥750) / B (≥600) / C (≥450) / D, cada banda con lectura de
negocio ("perfil bancable", "bancable con garantía", …). Los pesos arrancan heurísticos
(estándar de underwriting PyME), viven en un solo módulo versionado (`scoreVersion` en cada
cálculo) y se recalibran cuando haya outcomes reales.

**Salidas de la Fase 1:**
- Página "Perfil crediticio" (score, desglose por métrica, confiabilidad).
- **"Cómo mejorar tu perfil"**: acciones concretas derivadas de las métricas en rojo
  (presenta la declaración omitida, cobra las N facturas vencidas, diversifica clientes).
  Esto lo vuelve feature de retención aunque la empresa no quiera crédito.
- **Dossier PDF** estandarizado (el paquete que un banco/SOFOM espera recibir).

**Esquema (aditivo):** `CreditProfile { companyId, score, banda, confiabilidad, metricas
Json, scoreVersion, computedAt }` — un renglón por cálculo (histórico = ver evolución y
calibrar después).

## 4. Fase 2 — Capa de IA (reusa infraestructura existente)

- **Narrativa ejecutiva del dossier**: el LLM redacta el resumen que un analista de crédito
  leería (2-3 párrafos), citando sólo métricas del motor — nunca números propios. Se genera
  al exportar el dossier; costo dentro del presupuesto LLM por empresa (`CostEvent`).
- **Banderas cualitativas acotadas**: patrones raros en movimientos (ya categorizamos con
  LLM), loops de facturación con partes relacionadas, incoherencia actividad-vs-facturación.
  Cada bandera: severidad + evidencia + efecto máximo definido (p. ej. −25 pts, tope global
  Tier 3 de ±75).
- **El asistente explica el score** (in-app y WhatsApp): "¿por qué salí B?" → responde desde
  el desglose persistido, no recalcula.

## 5. Fase 3 — Señales externas (web / redes / presencia digital)

Sub-score de **presencia digital** (Tier 3, acotado), calculado con web search + LLM y
cacheado en un snapshot trimestral por empresa:

- Existencia y antigüedad de sitio web / dominio; correo con dominio propio.
- Google Maps / reseñas; directorios; actividad en redes (existencia y recencia, no likes).
- Menciones en noticias (positivas/negativas) — las negativas generan bandera, no veto.
- **Cross-checks de coherencia** (esto es lo valioso): la dirección declarada en el CSF vs
  Maps; el giro declarado vs lo que dice su sitio. Incoherencias = bandera de fraude
  potencial, útil también para el despacho al aceptar clientes.

Persistencia: `SenalExternaSnapshot { companyId, tipo, hallazgos Json, fetchedAt }`.
Costo por empresa medido y gateado (búsqueda sólo al calcular perfil, cache 90 días).
Todo hallazgo guarda su URL fuente — auditabilidad igual que el resto del sistema.

## 6. Fase 4 — Buró de Crédito (vía Syntage)

Cierra el único hueco de los datos SAT: **deuda existente y comportamiento de pago**.

- **Flujo de consentimiento primero**: autorización expresa del representante legal
  (Ley para Regular las SIC, Art. 28) — documento firmado/NIP, guardado con timestamp,
  IP y vigencia. Sin consentimiento vigente, el botón de Buró ni aparece. Confirmar con
  Syntage qué mecanismo de autorización soporta su API.
- Pull bajo demanda (nunca automático): reporte PM → señales Tier 2: deuda vigente,
  historial MOP, consultas recientes. Cifrado en reposo como las credenciales.
- **Score v2 = matriz fiscal × buró** (p. ej. fiscal A + buró limpio = A+; fiscal A +
  buró con atrasos = B con bandera). El score fiscal nunca desaparece — se reporta ambos.
- Costo por consulta visible al usuario (passthrough o incluido por tier — decisión de
  precio pendiente; preguntar tarifa a Syntage).

## 7. Fase 5 — Distribución y monetización

- **Dossier compartible**: enlace tokenizado con vencimiento (mismo patrón que los
  deep-links Tier 3) para mandar al banco/SOFOM; el dueño ve quién lo abrió.
- **Cartera del despacho**: vista multi-RFC "qué clientes califican" — upsell directo del
  despacho a sus clientes (y nuestro pitch al despacho white-label).
- **Referidos a fondeadores**: cuando haya volumen, partnerships donde el lead calificado
  paga comisión. Requiere el consentimiento del dueño para compartir el dossier — ya
  resuelto por diseño.
- **API** (`/api/credito/perfil`): expone el perfil a terceros vía la capa de API keys
  planeada — encaja con el roadmap de integraciones.
- **Pitch de onboarding**: "tu contabilidad te precalifica para crédito" como beneficio
  visible desde el registro.

## 8. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Score indefendible / caja negra | Motor puro, umbrales documentados, pruebas doradas, desglose visible |
| Consulta a Buró sin autorización (multa) | Flujo de consentimiento bloqueante, evidencia guardada |
| Parecer oferta de crédito (expectativas/regulación) | Disclaimer en UI y PDF; nunca "aprobado", siempre "perfil" |
| Gaming con auto-facturación | Señal 69-B, banderas de partes relacionadas, cruce banco-vs-CFDI (el flujo bancario no se fabrica gratis) |
| Datos flacos → score engañoso | Grado de confiabilidad obligatorio; sin mínimos (6m CFDI) no hay score, hay "perfil incompleto" |
| Costo de señales externas descontrolado | Cache 90 días + CostEvent + gating por tier |
| Privacidad (LFPDPPP) al compartir | Compartir sólo por acción del dueño, enlace con vencimiento, log de accesos |

## 9. Orden de construcción

| Fase | Entregable | Dependencias |
|---|---|---|
| 0-1 | `src/lib/credito/` (métricas + score, puro, dorado) · página Perfil · PDF · `CreditProfile` | Ninguna — datos ya existen |
| 2 | Narrativa LLM + banderas acotadas + asistente explica | Fase 1 |
| 3 | Señales externas + cross-checks + snapshot | Fase 1 (web search tooling) |
| 4 | Consentimiento + Buró vía Syntage + score v2 | Docs/tarifa de Syntage |
| 5 | Dossier compartible + cartera despacho + API + referidos | Fases 1-2 (y API keys) |

Fase 0-1 es una ola de PRs sin dependencias externas. Las fases 2-3 reusan infraestructura
(LLM budgets, tooling). La 4 espera la documentación de Buró de Syntage. La 5 es
producto+negocio sobre lo anterior.

## 10. Métricas de éxito

- % de empresas activas con perfil calculado y confiabilidad ≥ media.
- Dossiers exportados / compartidos por mes.
- Acciones de "mejora tu perfil" completadas (proxy de retención).
- (Fase 5) leads referidos y conversión.
