# Rediseño «Piloto del Cierre» — decisiones y fases

**Origen (2026-08-28):** dos propuestas del owner (A «Command Center», B
«Piloto del Cierre») sobre las recreaciones Contia de la UI actual. Decisión
del owner: **unificarlas** — B como pantalla de inicio (el mes como flujo
guiado de 5 pasos), y de A el chrome: **sidebar magra** (hoy 17 entradas) y
el **rail derecho del Copiloto con cajas de hallazgos** en lugar de sólo un
chat flotante. Este rediseño se construye JUNTO con la empresa demo (Fase 2
del GTM): la demo es el guion de B, B es el escenario de la demo.

**Hallazgo clave:** los tokens Contia (oklch) y Geist YA están en prod — la
capa visual migró en otra sesión. Lo que queda es estructura, no piel.

## Fase 1 — Chrome (este PR)

- **Sidebar magra** (17 → 10): Inicio · Operación[Facturas, Bancos,
  Directorio] · Fiscal[Impuestos, Contabilidad, Cumplimiento] · Nómina (UNA
  entrada — las 4 pestañas viven dentro de la página, como siempre debieron)
  · Cartera (sólo despacho) · abajo: Mi Empresa, Configuración.
  - **Directorio** = /clientes; clientes y proveedores se enlazan entre sí
    con un segmented control en sus headers (unificación de navegación, no
    fusión de páginas — eso sería otra fase).
  - **Verificador** deja la sidebar: es una herramienta puntual — acción
    «Verificar RFC» en el header del Directorio (la ruta vive igual).
- **Copiloto (rail derecho)**: persistente y colapsable en xl+, con las
  CAJAS DE HALLAZGOS del auditor fiscal (severidad, mensaje, sugerencia,
  fundamento, CTA) + pendientes del cierre; «Preguntar al copiloto» abre el
  chat existente (evento cos:ask-ai). El FAB del chat se oculta en xl (el
  rail es su nueva puerta). v2: chat embebido en el rail con pestañas.

## Fase 2 — B como Inicio: HECHA (2026-08-28)

El Inicio tiene DOS LENTES con toggle persistente (default: cartera si
operas 2+ empresas): **Empresa** = el Piloto del Cierre (los 5 pasos con
estado, la cifra que importa y una acción; compone /api/dashboard +
ce-readiness + nomina/hub client-side — cero backend nuevo) y **Cartera** =
la Cola de Trabajo (Propuesta A: una fila por cosa-que-hacer en los N RFC,
una acción por fila, click activa la empresa y navega; /api/inicio/cola
batcheado al estilo despacho/cockpit — jamás computeTaxPosition ni balanza
en abanico; sin clasificar = UNMATCHED + IGNORED sin tag, el criterio que
bloquea el cierre). La banda del «$0.00 vencido» MURIÓ: el paso Declara
distingue importe calculado / por calcular / informativa. El ranking de la
cola es puro y testeado (armarCola). PendientesDelCierre queda sin consumo
(el Piloto lo reemplaza) — borrar en limpieza futura.

## Fase 3 — Empresa demo

Seed de una empresa ficticia realista (CFDIs, banco a medio conciliar,
quincena en vuelo, declaración armada) para que B luzca vivo en un demo sin
exponer el RFC de un cliente real. (Detalle en el plan GTM.)

## Explícitamente pospuesto

El Command Center completo de A (cola de trabajo como pantalla, vistas
densas multi-RFC): es la superficie del usuario avanzado en el mes tres —
espera feedback de pilotos. El ⌘K ya existe (CommandPalette). El copiloto
agéntico (acciones desde el chat) espera la capa Tier 3 del roadmap.
