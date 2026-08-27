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

**Ola B — posteo (los tres agujeros del banco):**
1. Pagos de impuestos conciliados contra `TaxDeclaration` no se postean
   (`posting.ts` TODO(impuestos)) → Bancos sobrevaluado. Postearlos como
   DR Impuestos y derechos / AB Bancos (igual que IGNORED+TAX_PAYMENT).
2. Una sola cuenta 102.01 para todos los bancos → subcuenta por
   `BankAccount` (mata la doble contabilización de traspasos internos y da
   CtaOri/CtaDest reales).
3. `IGNORED` sin tag desaparece → debe bloquear el cierre igual que
   UNMATCHED (misma disciplina).

**Ola C — reclasificación de IVA (el premio contable):** hoy el IVA se
postea a 208/118 al TIMBRAR — el libro afirma que todo está cobrado/pagado.
Correcto: devengo a 209/119 (pendiente) y reclasificación proporcional a
208/118 al conciliar el cobro/pago. Las cuentas ya existen en el catálogo
(constantes muertas en `catalog.ts`). Con esto la balanza ata contra la
DIOT (que ya es de flujo).

**Ola D — UX del cierre:** /contabilidad como «Cierre del mes» guiado — un
solo flujo con pasos gateados (CFDIs ✓ → banco conciliado → postear →
cuadre → entregables), el semáforo de readiness DESHABILITANDO descargas en
vez de decorarlas, y el diagnóstico de evidencia bancaria visible.

**Notas de alcance:** cheques no se emiten (no capturamos cheques; SPEI
cubre la operación real). c_Banco incluye «999» genérico — no lo usamos:
omisión honesta > código de relleno. Balanza con saldos contrarios a su
naturaleza: pendiente de revisar la identidad aritmética con magnitudes
absolutas (caso borde, documentado en la auditoría).
