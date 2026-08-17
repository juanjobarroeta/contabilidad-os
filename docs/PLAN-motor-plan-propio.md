# Plan: el motor de posteo sobre el plan de cuentas de la empresa

**Meta**: UN solo estado financiero. El motor deriva sobre las MISMAS cuentas
que el contador declara, la diferencia mensual contra la balanza presentada
(`CeBalanzaMes`) se vuelve una lista de ajustes con nombre, y cuando esa lista
la captura el contador en el sistema (fuente MANUAL, que `postMonth` ya
preserva), derivado + capturado = declarado. Ahí los dos estados son uno, y el
paso final es GENERAR la CE desde aquí en vez de espejearla.

No se vende «nuestros números en vez de los tuyos»: se vende «día uno espejamos
lo declarado; luego te demostramos cuánto lo re-derivamos de documentos, y te
enseñamos las diferencias que no sabías que tenías». El contador pasa de
capturista a revisor. La conciliación de inventario ($272M → $28.7M explicados)
es el precedente del método.

Por qué es factible sin cirugía: `postMonth` es IDEMPOTENTE (borra y regenera
CFDI/NOMINA/BANCO/DEPRECIACION por período y preserva lo manual). Cambiada la
resolución de cuentas, re-postear la historia ES la migración.

## Fase 0 — persistir `CodAgrup` (hecha)

El CT de la empresa declara el agrupador de cada cuenta propia
(4101-0027 → «401.01»); el import lo parseaba y lo tiraba. Ahora
`ChartAccount.codAgrup` lo guarda (create y update; un CT sin él no borra la
llave). Se rellena solo con el siguiente harvest del sync (importarCatalogo).

## Fase 1 — resolución al plan propio, con fallback

`resolverCuentaEmpresa(companyId, codigoMotor)`: invertir codAgrup → cuenta(s)
propia(s). Sin ambigüedad → esa cuenta. Con varias candidatas (los agrupadores
de gasto existen por DEPARTAMENTO: 6100/6300/6400/6600/6700 comparten
plantilla) → tabla chica de overrides por empresa (se siembra sola con las no
ambiguas; las ambiguas las decide el contador UNA vez). Sin mapeo → fallback al
stub agrupador de hoy (adopción gradual, cero big-bang). Shim en el único punto
de resolución del motor; re-posteo de la historia al activarlo.

### Cobertura medida (MARGOM, 2026-08-16)

38 códigos usa el motor. **16 resuelven ÚNICOS ya** — entre ellos IVA
acreditable 118.01 ($772M posteados) y toda la familia de activo fijo 171.xx —
y se flipan al plan propio con el siguiente re-posteo. **Los cuatro gigantes
son AMBIGUOS por construcción**: 105.01 clientes ($6.9B, 22 candidatas),
401.01 ventas ($6.0B, 130 — una por familia/depto), 201.01 proveedores
($5.9B, 10) y 601.84 otros gastos ($4.8B, 48). Ésos son ~10 decisiones de
override del contador (clientes/proveedores tienen UNA cuenta general obvia
que la CE puede validar por montos antes de proponerla) más la Fase 2 para
ventas/costo/inventario por familia. **Sin candidata** (el CT no declara ese
agrupador): 701.10 ($39.6M), 601.32 ($9.9M), 601.50 ($0.7M) — se quedan en
stub hasta el export del contador.

## Fase 2 — resolución por módulo (AUTOMOTRIZ)

La venta/costo/inventario de una unidad resuelve por su FAMILIA a la subcuenta
exacta (4101-00XX / 5101-00XX / 1301-00XX): el mapa modelo→familia ya existe
(divergencia-ce). Aquí el derivado por familia se vuelve comparable renglón a
renglón contra la CE — la conciliación de inventario, pero automática y mensual.

## Fase 3 — rubros exactos, cada uno con su checksum CE

En orden de tractabilidad (datos completos de nuestro lado):
1. **CxC / CxP**: CFDIs + REPs dan el aging derivado completo; checksum contra
   105/2xxx de la balanza.
2. **IVA**: el motor cash-basis contra el IVA DECLARADO (Syntage tiene las
   declaraciones mensuales).
3. **Depreciación / activo fijo**: el motor ya postea DEPRECIACION y existe el
   ajuste INPC; alinear vidas/tasas contra la depreciación declarada por cuenta.
Cada rubro estrena su panel de divergencia mensual (el patrón del inventario).

## Fase 4 — el cierre con residuo

Panel de cierre: derivado vs declarado por cuenta; el residuo se captura como
asientos MANUAL del contador (ya preservados). Residuo = $0 sostenido →
**un solo estado de resultados**, y la CE se genera desde el sistema.

## Riesgos conocidos

- El CT presentado está incompleto (12 cuentas en uso sin catálogo — pedido el
  export del ERP del contador): la inversión necesita ese export para cubrirlas.
- Los ~$1.4B de traspasos internos (divergencia-ce): el motor no los deriva y
  no debe — viven en el residuo del contador o se modelan como reglas después.
- Era agrupador (pre-2024-10): la historia vieja se queda en agrupador; la
  resolución al plan propio aplica desde donde el CT propio existe.
