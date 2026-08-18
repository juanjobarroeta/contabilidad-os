# Brief de diseño — Contabilidad contador-grade

**2026-08-17.** El backend ya reemplaza a Aspel COI — los cinco XML del Anexo 24
validados contra los XSD del SAT, motor de pólizas idempotente, balanza declarada
importada al centavo. El frente no: hoy es **una página de 1,239 líneas con 10
tabs** (`src/app/(app)/contabilidad/page.tsx`) y una captura de pólizas de 123
líneas. Este brief define los módulos que convierten APIs de ingeniero en el
instrumento de trabajo diario de un contador que viene de COI.

Versión visual del brief (misma estructura, para revisión):
https://claude.ai/code/artifact/0af2fcf3-048c-4d86-988d-3f5d1f680c4d

## La persona y su vara de medir

El usuario es **el contador externo de una PyME mexicana** con 10+ años en
COI/CONTPAQi: captura pólizas con puro teclado, imprime auxiliares para revisar,
y su entregable del mes son la balanza, los XML de CE y las declaraciones. Nos
mide contra su memoria muscular: si capturar una póliza de ajuste toma más clics
que en COI, perdimos. Nuestra ventaja no es la captura — es que **el sistema ya
derivó el ~95% de las pólizas desde los CFDIs** y puede mostrarle exactamente en
qué difiere lo derivado de lo que él declara.

> **Tesis de producto (plan CE-first):** «día uno espejamos lo declarado; luego
> te demostramos cuánto lo re-derivamos de documentos, y te enseñamos las
> diferencias que no sabías que tenías». El contador pasa de capturista a
> revisor. Cada pantalla sirve a esa transición.

## Alcance

Este brief rediseña **el mes del contador** (la sección contabilidad), no **el
día del operador**: facturación (`/facturas`, prefacturas DRAFT, timbrado con
llave de idempotencia) y conciliación (`/bancos`) **sobreviven intactas** — la
conciliación de hecho se PROMUEVE a compuerta del cierre. El satélite AutomotrizPro
tiene su propio design system; este brief es del hub y conserva el sistema visual
del hub — define estructura y comportamiento, no re-branding.

## Arquitectura: de 10 tabs a 6 módulos con flujo

Tabs actuales sin flujo: `periods · coe · ce-presentado · libro · balanza ·
conciliacion · estado · balance · saldos · activo-fijo`.

### P0 · 1. El Cierre del Mes *(nuevo)*

*«Quiero cerrar julio y saber exactamente qué me falta para poder declararlo.»*

La pantalla principal: **el cierre como checklist vivo**, un stepper por período:

1. **Documentos** — CFDIs sincronizados, huecos de cobertura, bancos importados.
   API: `ce-readiness`.
2. **Conciliación** — los movimientos sin conciliar bloquean el cierre (regla que
   el motor YA impone); el conteo como obstáculo #1 con liga directa a `/bancos`.

   **2b. Obligaciones** — «REPs pendientes: 7 · DIOT: sin generar · Depreciación:
   corrida ✓» (ver módulo 6).
3. **Posteo** — «Postear el mes» con preview (`balanzaPreview`); decir qué se
   regenera y qué se preserva (MANUAL/APERTURA) para quitar el miedo al botón.
4. **Divergencia** — derivado vs declarado (módulo 2). El corazón.
5. **Ajustes** — pólizas manuales para el residuo (módulo 3).
6. **Entregables** — los XML de CE listos (módulo 5).

Estado por paso: listo / pendiente / bloqueado, siempre con el número que importa
(«43 movimientos sin conciliar»), nunca sólo un ícono. El período se elige una
vez y persiste en todos los módulos.

### P0 · 2. Divergencia derivado ↔ declarado *(nuevo)*

*«¿En qué difiere lo que el sistema derivó de lo que yo presenté al SAT?»*

La pantalla que nadie más tiene. Los datos ya existen: balanza derivada
(`AccountingEntry`) contra balanza presentada (`CeBalanzaMes`, 42 períodos en
MARGOM), por cuenta y por mes. En MARGOM esto redujo $1.6B de ruido a $44M con
nombre.

- **Vista rubro → cuenta → mes → documentos**: un renglón por cuenta con
  derivado, declarado y diferencia; drill hasta los CFDIs/asientos de cada lado.
- **Cada diferencia se «adopta»**: se convierte en póliza de ajuste (módulo 3),
  se marca «así lo clasifico yo» (alimenta `PostingCuentaOverride`), o se marca
  explicada con nota. Meta visible: residuo → $0 sostenido.
- Semáforo por magnitud **relativa al rubro**, no por valor absoluto.

### P0 · 3. Captura de pólizas a la altura de COI *(rehacer)*

*«Necesito registrar el ajuste sin soltar el teclado.»*

- **Teclado primero**: autocompletar cuenta por código o nombre («601» → lista;
  «gasolina» → 601.48), Tab avanza, Enter agrega renglón, descuadre vivo
  (cargos − abonos), no se guarda descuadrada.
- Tipos Ingreso / Egreso / Diario como en COI.
- **Plantillas y recurrentes**: duplicar la del mes pasado en un clic.
- **Pegar desde Excel**: columnas cuenta/concepto/cargo/abono.
- API existente: `polizas-manuales` (fuente MANUAL, nunca la pisa el re-posteo —
  decirlo en la UI).

### P1 · 4. Catálogo y decisiones de mapeo *(nuevo)*

*«¿A qué cuenta MÍA va cada cosa que el motor postea?»*

- Catálogo navegable con `codAgrup` visible y editable; cuentas sin nombre y
  huérfanas de agrupador como **bandeja de pendientes**.
- **La cola de ambigüedades**: códigos del motor con varias candidatas (hoy se
  resuelven por script) como decisiones de un clic que escriben
  `PostingCuentaOverride`; cada decisión muestra cuánto dinero re-postea.
- Importar catálogo del CT (`import-ce`) expuesto con diff.

### P1 · 5. Centro CE y reportes imprimibles *(consolidar)*

*«Dame los archivos del mes para el buzón, y el auxiliar imprimible.»*

- **Los cinco XML del Anexo 24 por período** (catálogo, balanza con N/C
  automática vía hash de `CoeEnvio`, pólizas, aux. cuentas, aux. folios) con su
  estado; descarga en ZIP nombrado como el SAT lo espera.
- Libro diario, auxiliares y balanza con **CSS de impresión real** y export XLSX
  — el contador imprime para revisar con pluma; ese hábito se sirve, no se pelea.
- APIs: `coe/*`, `libro-diario`, `auxiliar`, `balanza`, `balance-general`,
  `estado-resultados`.

### P0 · 6. Obligaciones del período: REPs, nómina, DIOT, activos *(integrar)*

*«Antes de declarar necesito: emitir los REPs que debo, la nómina provisionada,
la DIOT lista y la depreciación corrida.»*

Casi todo el plumbing EXISTE — el trabajo es meterlo al flujo del cierre como
pasos con número:

- **Complementos de pago**: cola de **REPs pendientes** (PPD cobradas sin
  complemento) con emisión en lote. Assets: `complementos-rep-emit`, auditoría
  `rep-faltante`, `PagoDoctoRelacionado`. Mostrar cuánto IVA en flujo se mueve
  si se emiten los pendientes.
- **Nómina**: los tabs existen (corridas, empleados, IMSS, cumplimiento); falta
  su **cara contable** en el cierre: percepciones, ISR retenido por enterar,
  provisión en acreedores (2207) y su liquidación bancaria, cuotas IMSS. Un
  renglón por concepto con su asiento derivado, no otra captura.
- **DIOT**: existe `/api/impuestos/diot` y el layout batch 2025 está en
  `docs/DIOT-2025.md`: «generar .txt del período» como paso del cierre, con
  conteo de proveedores y el IVA acreditable que ampara.
- **Activo fijo**: el tab existente como verificación — depreciación corrida,
  altas desde CFDIs INVERSION, bajas con efecto en resultados.

## Principios de interacción

- **El período es el contexto global**: selector sólo de períodos que existen
  (como ya hace `ce-serie`); toda la sección lo respeta.
- **Números con dignidad**: `tabular-nums`, alineación derecha, centavos siempre.
- **El botón peligroso explica qué preserva**: re-postear dice «regenera
  CFDI/NÓMINA/BANCO; tus pólizas manuales y la apertura no se tocan».
- **Nada de estados vacíos mudos**: cada pantalla sin datos dice qué falta y de
  dónde viene.
- **Roles**: dueño ve resumen y divergencia; contador todo; operador captura
  pero no cierra.

## Métricas de éxito

| Métrica | Hoy | Meta |
|---|---|---|
| Pasos para cerrar un mes | 10 tabs sin orden | 1 flujo de 6 pasos |
| Captura de póliza de 4 renglones | formulario básico | < 40 s, sin mouse |
| Divergencia sin explicar (MARGOM) | $44.1M con nombre | $0 sostenido, adoptada en UI |
| Decisiones de mapeo pendientes | scripts en terminal | bandeja en UI |

## Fases para la sesión de diseño

| Fase | Alcance | Entregable |
|---|---|---|
| P0 | Cierre + Divergencia + Obligaciones (módulos 1–2–6) | Flujo completo con datos reales de MARGOM como fixture |
| P0 | Captura de pólizas (módulo 3) | Prototipo navegable con teclado, probado con un contador real |
| P1 | Catálogo + Centro CE (módulos 4–5) | Pantallas + CSS de impresión |

Piloto de referencia: **MARGOM** (42 balanzas CE importadas, divergencia medida,
catálogo con pendientes reales) — sus números son el contenido de diseño, no lorem.
