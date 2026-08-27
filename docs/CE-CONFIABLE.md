# CE confiable — auditoría y plan

**Pregunta del owner (2026-08-28):** ¿los movimientos bancarios afectan las
pólizas? ¿Se puede presentar Contabilidad Electrónica al SAT con confianza?

**Respuesta corta:** el motor de posteo sí es de caja + devengado (los
movimientos conciliados generan asientos reales contra Bancos y un mes con
UNMATCHED no cierra) — mejor que Aspel/Alegra en arquitectura. La capa de
XML tenía dos rojos que ya se cerraron (PR «CE: XML que el SAT no rebota»);
quedan tres olas de fondo.

## Cerrado (2026-08-28)

- **CodAgrup real** en el catálogo XML (`coe-xml.ts`): usa
  `ChartAccount.codAgrup` (planes propios importados); antes emitía el código
  interno y el SAT rechazaba el archivo por la enum cerrada del XSD.
- **Nodo `Transferencia`** en pólizas bancarias (`coe-bancos.ts` +
  `coe-polizas.ts`): banco origen/destino derivado de CLABE (los 3 primeros
  dígitos SON el código c_Banco), RFC del tercero (CFDI conciliado → SPEI →
  genérico del SAT), Benef por dirección. **Jamás se inventa**: si un lado no
  resuelve, el nodo se omite y el diagnóstico va en headers
  (`X-Polizas-Sin-Evidencia`) — visible, no mudo.
- **Compuerta dura**: balanza/pólizas/auxiliares sólo de meses POSTED/CLOSED
  (`assertMesPosteado`). Antes, un mes sin postear producía una balanza
  válida y vacía que nada impedía subir al SAT. El paquete degrada con
  gracia: el entregable omitido queda declarado en el LEEME.
- **Validación en runtime** (`coe-validador.ts`): enums c_CodAgrup/c_Banco
  leídas de los MISMOS XSD embarcados (no puede desfasarse), partida doble
  por póliza, RFCs bien formados. Rutas y paquete fallan cerrado (422 con
  detalles) — antes sólo validaban los tests, y se saltaban sin xmllint.
- **Auxiliar de folios**: mismo fallback de RFC desde rawXml que las pólizas
  (antes un CFDI recibido sin proveedor ligado desaparecía en silencio).

## Pendiente — olas de fondo

**Ola B — posteo: CERRADA (2026-08-28).** Enteramientos conciliados contra
`TaxDeclaration` postean (espejo de TAX_PAYMENT; devolución invertida). Con
2+ cuentas bancarias, cada una postea en su subcuenta contable propia
(102.01.NN, creada y ligada vía `BankAccount.chartAccountId`; CodAgrup
heredado del padre) y los traspasos internos generan UNA póliza cruzada — el
depósito espejo se detecta y no duplica (`planearTraspasos`, pura y
testeada). `IGNORED` sin categoría BLOQUEA el cierre igual que UNMATCHED.
Primer itest de `postMonth` contra Postgres real. Notas: con una sola
cuenta bancaria nada cambia (cero churn); los saldos históricos migran a
subcuentas mes a mes al RE-postear — no automáticamente; los matches de
construcción (Gasto/Raya/Reembolso) siguen fuera de este motor (satélite).

**Ola C — reclasificación de IVA: CERRADA (2026-08-28).** El devengo postea
a las cuentas PENDIENTES (AB 209.01 trasladado / DR 119.01 acreditable,
Art. 1-B LIVA) y al conciliar el cobro/pago el motor reclasifica
proporcionalmente a 208.01/118.01 (`reclasificacionIvaFlujo`, pura: usa el
MISMO delta total−subtotal del devengo, así la pendiente queda exactamente
en cero al liquidar — retenciones incluidas; el aplicado exacto sale del
montoAsignado en 1-a-varios). **Regla de transición:** sólo reclasifican
facturas cuyo devengo pasó por 209/119 (las legadas con devengo directo a
208/118 conservan su tratamiento hasta re-postear su mes) — las dos
generaciones conviven sin descuadrar. balanzaPreview espeja el devengo
nuevo. Con esto el saldo de 208 en la balanza ES el IVA cobrado del
periodo: ata contra la DIOT (flujo). Itests: devengo/reclas/parcial/legada
en Postgres real, re-posteo idempotente.

**Ola D — UX del cierre:** /contabilidad como «Cierre del mes» guiado — un
solo flujo con pasos gateados (CFDIs ✓ → banco conciliado → postear →
cuadre → entregables), el semáforo de readiness DESHABILITANDO descargas en
vez de decorarlas, y el diagnóstico de evidencia bancaria visible.

**Notas de alcance:** cheques no se emiten (no capturamos cheques; SPEI
cubre la operación real). c_Banco incluye «999» genérico — no lo usamos:
omisión honesta > código de relleno. Balanza con saldos contrarios a su
naturaleza: pendiente de revisar la identidad aritmética con magnitudes
absolutas (caso borde, documentado en la auditoría).
