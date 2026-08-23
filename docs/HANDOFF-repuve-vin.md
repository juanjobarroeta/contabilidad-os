# Handoff: verificación de VIN contra REPUVE (inventario, seminuevos, robo)

Contexto para el agente que construya el workflow de consulta de VIN al registro
público vehicular. La idea nació resolviendo el inventario de MARGOM, pero el
valor mayor es continuo, no de una sola vez.

## Por qué — tres usos, en orden de valor

1. **Protección contra robo (continuo, el más importante).** Antes de comprar un
   seminuevo o de recibir una unidad a cuenta, consultar el NIV en REPUVE dice si
   trae reporte de robo. Comprar un auto robado es un pasivo enorme —legal y
   financiero—. Esto es prevención en cada operación, no limpieza histórica.
2. **Seminuevos (continuo).** Al dar de alta un seminuevo, REPUVE valida que el
   NIV existe, y su marca/modelo/año contra lo que dice el vendedor. Cruza con el
   catálogo de clave vehicular (Anexo 15, ya poblado) para cazar discrepancias.
3. **Reconciliación de inventario (una vez).** Quedan **~417 unidades nuevas
   recientes (2024+) en el piso de MARGOM, $185.3M**, que ninguna señal INTERNA
   resuelve (ver abajo). Un VIN registrado con placas en REPUVE = se vendió y
   circula. Es el único resolvedor que queda para ese piso.

## Qué se agotó internamente (para no repetirlo)

Sobre las 498 (ahora 496) unidades de piso de MARGOM, ya se probó y dio CERO:
- **Historia de servicio** (VIN en CFDI de taller): 0 — los CFDIs de servicio casi
  nunca traen el NIV (6 de 29,523 servicios ligan vehículo).
- **Recompra como seminuevo** (VIN reaparece usado): 0.
- **Egreso**: 471 tienen el VIN en un egreso, pero es su propia COMPRA
  (planta→agencia es egreso para nosotros), no una señal de venta.
- **Linker** (ligar-ventas-huerfanas): agotado; los últimos 2 REFACT ya se
  ligaron con FORZAR.
- Partición restante: **79 viejas (≤2023, $25.8M)** = baja probable; **417
  recientes** = incógnita que sólo REPUVE resuelve.

## El recurso

- **REPUVE** (Registro Público Vehicular), consulta ciudadana pública: se
  ingresa el NIV y devuelve inscripción, marca/modelo/año, y estatus de **robo**.
  Es PÚBLICA — no necesita FIEL ni credencial (más simple que el portal SAT en
  eso). El obstáculo es un **CAPTCHA** en el formulario.
- **RENAVE** (Registro Nacional de Vehículos): registro de transacciones, más
  nuevo; complementa pero es más fragmentado.
- **Control vehicular estatal** (placas/tenencia): por estado, no nacional —
  dejar para después.

Límites honestos de la señal: un auto vendido hace poco puede no estar registrado
aún (falso «no vendido»); el detalle de propietario es limitado por privacidad;
la cobertura de placas para carga/comercial varía. REPUVE resuelve MUCHOS de los
417, no todos.

## Cómo — reusar lo ya construido

El patrón es el mismo del recon del portal SAT de esta semana:
- **`scripts/recon-sat-portal.ts`** — plantilla de recon con Playwright (headed,
  graba HAR + capturas, bitácora por paso). Playwright ya está en package.json.
- Primer paso IGUAL que con el SAT: **recon del formulario** — mapear qué campos
  pide, cómo responde, y qué tipo de captcha es. NO adivinar; grabar el tráfico
  real de una consulta y volverlo fixture.
- **El CAPTCHA es la decisión de arquitectura.** A diferencia del SAT (donde la
  e.firma lo evitaba), REPUVE no tiene ruta sin captcha. Opciones a evaluar en el
  recon: si es reCAPTCHA/hCaptcha (servicio de resolución) o una imagen simple
  (OCR). Medir antes de comprometerse.
- **Idempotente y con rate-limit**: 417 VINs de golpe = pedir bloqueo. Lote
  chico, pausa entre consultas, cursor durable (como los backfills de refacciones
  y servicio). `scripts/lib/empresa.ts` para parametrizar por empresa.

## Modelo de datos (falta)

`Vehiculo` NO tiene campos de REPUVE hoy (`vin` sí existe, es la llave). Agregar,
vía migración:
- `repuveEstatus` (inscrito / no encontrado / robo)
- `repuveConsultadoAt` (para no reconsultar y para caducar la señal)
- opcional `repuvePlacas` / `repuveRaw` (JSON de la respuesta)

Usarlos: inventario (inscrito+placas → marcar vendida), seminuevo (validar alta),
robo (bloquear compra). El robo debe DISPARAR alerta, no sólo guardarse.

## Al alta (onboarding)

Encaja como etapa de enriquecimiento externo, igual que la conciliación bancaria:
no bloquea el alta (el estado de resultados no la necesita), pero limpia el
inventario y protege cada compra de seminuevo desde el día uno. Ver
`docs/onboarding/DISENO-orquestador.md` para dónde caen las etapas externas.

## Primer entregable sugerido

1. Recon de la consulta REPUVE (1 VIN real, grabar forma + captcha).
2. Decidir la estrategia de captcha con esa evidencia.
3. Migración de campos en `Vehiculo`.
4. Checker en lote idempotente + rate-limited, sobre los 417 primero.
5. Alerta de robo enganchada a la compra de seminuevos.
