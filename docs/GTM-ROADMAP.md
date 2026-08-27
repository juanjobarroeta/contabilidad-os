# GTM — Seis meses a vendible

> Plan comercial. Nace de una revisión tipo due-diligence (ago 2026) del repo
> y de un barrido de capacidades de Tesio, Contalink, Alegra y CONTPAQi.
> Versión web: artifact "Six Months to Sellable" en claude.ai.
>
> **El veredicto de la revisión:** la profundidad del producto ya compite —
> lo que falta es confianza visible, un solo ICP y una máquina de
> distribución. Este plan construye exactamente eso, en orden, sin pausar el
> producto.

## La tesis

**El posicionamiento es el ciclo cerrado:**
`SAT → conciliación → declaración → nómina → libro mayor` — nadie más tiene
los cinco en un solo producto. Tesio no tiene nómina ni facturación.
Contalink no tiene profundidad de IA. Alegra es empresa-first, no
despacho-first. CONTPAQi es escritorio legacy. Cada fase de abajo existe para
que esa frase sea **creíble para un desconocido**.

**"Vendible" son tres números:**

1. **10 despachos** pagando *a distancia de brazo* (sin relación personal o
   familiar).
2. **< 30 min** de FIEL cargada a "aquí están tus últimos 5 años" — el
   momento mágico que cierra el demo.
3. **≥ 80 %** de retención de logos a 6 meses en la cohorte piloto.

---

## Fase 0 — La decisión (semana 1)

Un solo ICP, dicho en voz alta, aplicado por el backlog. **El despacho es el
cliente.** Una firma amortiza el costo entre muchas empresas, el producto ya
trae Despacho/roles/multi-empresa, y el tier de $299 por empresa es la única
línea de ingreso con forma de venture.

- [ ] **Frase de posicionamiento en todas partes** — "El despacho opera el
  mes completo de cada cliente en un solo lugar." Landing, guion de demo,
  README. Toda petición de feature se contrasta contra ella. *(README: ✅
  este PR.)*
- [ ] **Congelar los verticales** — padel, restaurante, purificadora,
  automotriz pasan a mantenimiento: bugs sí; features sólo pagadas y sólo si
  generalizan. Financian runway; ya no son la historia.
- [ ] **Ingreso legible** — separar en la contabilidad propia el ingreso de
  partes relacionadas del SaaS a distancia de brazo, desde este mes. *(Manual,
  dueño.)*

## Fase 1 — Que sea seguro venderlo (semanas 1–6)

Un despacho desconocido va a confiarnos FIEL, CIEC, nómina y bancos. **Todo
hueco conocido de correctitud y seguridad se cierra antes del primer demo en
frío.**

- [ ] **Dinero: Float → Decimal** *(L)* — 234 campos Float en el schema de un
  producto contable. Primero las escrituras nuevas, luego backfill con script
  de validación, cuadre contra totales conocidos.
- [x] parcial **Cerrar la migración de tokens y la cola Bóveda** *(M)* — legacy
  retirado (2026-08-27: emisión y verificación eliminadas); resolver los dos hallazgos
  abiertos (scoping de despacho en `verificador`, `companyId` en
  `push/subscribe`); seguir el orden del plan.
- [ ] **Pasada de confiabilidad en las ~20 pantallas de dinero** *(M)* —
  estados de error, vacío y carga en bancos, facturas, nómina, declaraciones,
  contabilidad. El contador perdona el feature que falta; nunca la falla.
  Presupuesto de errores en Sentry y sostenerlo.
- [ ] **Cara pública** *(M)* — README *(✅ este PR)*, refresh del sitio,
  changelog público, status page, SECURITY.md, docs. Un producto construido
  por una persona tiene que verse institucionalmente vivo.
- [ ] **Postura de responsabilidad** *(S)* — términos que enmarcan el
  producto como instrumento del contador (el contador revisa y firma; el
  producto calcula y documenta). Una hora de abogado; explorar E&O.

## Fase 2 — Que la confianza se vea (semanas 4–10)

El producto es profundo pero se renderiza como tablas. **Las gráficas son
cómo el cliente percibe que la contabilidad está bajo control** — y el PDF
del despacho es cómo el despacho justifica su iguala.

- [ ] **Capa de reportes y visualización** *(L)* — un solo sistema de
  gráficas; las cinco que venden: ingresos vs egresos, flujo de efectivo,
  proyección de impuestos del mes, cartera vencida, costo de nómina. El mayor
  hueco de valor percibido vs Alegra y Tesio.
- [ ] **Entregables PDF con marca del despacho** *(M)* — reporte de cierre
  mensual con el logo del despacho: el artefacto que le entregan a su
  cliente. Cuando tu producto produce su entregable, el churn se vuelve
  estructuralmente difícil.
- [ ] **Empresa demo con datos sembrados** *(M)* — una empresa ficticia
  realista (CFDIs, movimientos, nómina, una declaración a medio vuelo) en un
  clic. Vender no puede depender de enseñar el RFC de un cliente real.
- [ ] **Onboarding como teatro** *(M)* — medir FIEL → historial de 5 años →
  apertura, punta a punta; objetivo < 30 min con progreso visible. Este
  momento cierra ventas: instrumentarlo, pulirlo, ensayarlo.
- [ ] **Pasada responsive + higiene de monolitos** *(S)* — las 10 pantallas
  top bien responsivas (PWA + push ya le ganan a los incumbentes; terminar el
  trabajo). Partir las páginas de 1,800 líneas al tocarlas — seguro de
  velocidad, no rewrite.

## Fase 3 — Fabricar distribución (semanas 8–16)

Nada en el repo vende. **Venta fundador-directo a 10 despachos a distancia de
brazo**, alimentada por un lead magnet y SEO comparativo — el playbook exacto
que Tesio corre contra nosotros, corrido mejor porque el producto es más
profundo.

- [ ] **Programa piloto: 10 despachos** *(L)* — onboarding de la mano, office
  hours semanales, precio anual (10 meses) con mínimo de 10 empresas. El
  universo: ~15,000 despachos chicos. La ventaja injusta: el fundador
  contesta el WhatsApp.
- [ ] **Lead magnet: diagnóstico fiscal gratis** *(M)* — CIEC entra →
  screening EFOS/69-B, complementos de pago faltantes, opinión de
  cumplimiento — PDF compartible, gratis. Cada hallazgo es una razón para
  suscribirse; el reporte vende solo.
- [ ] **Páginas comparativas** *(M)* — vs Contalink, vs Tesio, vs CONTPAQi,
  vs Alegra. Tablas honestas: el ciclo cerrado las gana en papel. Es
  exactamente cómo mercadea Tesio hoy; disputar las mismas búsquedas.
- [ ] **Ruido con la historia de IA** *(S)* — Alegra sacó comunicado en junio
  2026 por "consulta tus finanzas desde Claude". Nuestro agente WhatsApp +
  MCP lleva más tiempo vivo y llega más hondo. Un video demo, un launch post,
  a los mismos medios.
- [ ] **Colegios y referidos** *(S)* — presentar en colegios de contadores;
  descuento por despacho referido. El gremio es chico y platica: la cohorte
  piloto es la fuerza de ventas.

## Fase 4 — Probarlo y des-riesgar al fundador (meses 4–6)

Convertir el piloto en evidencia. **Retención, un caso de estudio, una
revisión de seguridad y una primera contratación** — lo que convierte
"proyecto solo impresionante" en "empresa".

- [ ] **Dashboard interno de métricas** *(S)* — despachos, empresas
  administradas, declaraciones presentadas/mes, retención, tiempo de
  onboarding. Revisión semanal.
- [ ] **Primera contratación: QA + soporte** *(M)* — no otro constructor: una
  persona que haga sentir el producto atendido y libere horas del fundador
  para vender.
- [ ] **Pentest externo + página pública de seguridad** *(M)* — un pentest
  pagado, hallazgos corregidos, prácticas publicadas (cifrado, bitácora,
  aislamiento de tenants, gitleaks). SOC 2 puede esperar; la higiene visible
  no.
- [ ] **El primer caso de estudio** *(S)* — un despacho piloto, con nombre y
  números: horas ahorradas por cierre, declaraciones presentadas, clientes
  migrados.

---

## Lo que NO está en este plan — a propósito

- **Verticales nuevos.** Ni POS de restaurante, ni features de flotilla, ni
  satélites nuevos hasta que el marcador esté en verde.
- **Perfil crediticio.** Un segundo negocio escondido dentro del primero.
  Estacionado hasta terminar la Fase 4.
- **Grupos de WhatsApp / moonshots de Meta.** Bloqueado por plataforma y no
  es lo que cierra un despacho.
- **Amplitud de features de IA.** No perseguir las "38 funcionalidades" de
  Alegra — la profundidad del ciclo cerrado es el foso; la amplitud es su
  juego.
- **Rewrite del frontend.** Partir monolitos al tocarlos. Un rewrite son
  seis meses parados.

**La regla permanente: nada se construye para un solo cliente salvo que esté
pagado y generalice al ICP de despachos.**

## El marcador

"Vendible y competitivo" son estos siete números, nada más suave:

| Métrica | Objetivo | Qué prueba |
|---|---|---|
| Despachos a distancia de brazo pagando | 10 | Hay demanda fuera de la red del fundador |
| Empresas administradas | ≥ 100 | La cuña del despacho multiplica |
| Retención de logos a 6 meses | ≥ 80 % | Es producto, no favor |
| FIEL → historial 5 años | < 30 min | El demo se cierra solo |
| Uptime (status page) | ≥ 99.9 % | Seguro para el cumplimiento de un cliente |
| Declaraciones presentadas / mes | creciendo | El ciclo central se usa de verdad |
| Parte del MRR a distancia de brazo | ≥ 50 % | Ingreso que un tercero puede creer |
