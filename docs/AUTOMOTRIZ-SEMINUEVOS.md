# Seminuevos y toma a cuenta — diseño fiscal y operativo

> **Estado: DISEÑO PARA REVISIÓN DEL CONTADOR.** La parte operativa (alta del
> seminuevo al facturar el pedido) ya está implementada; el tratamiento de IVA
> sobre margen NO se activa hasta validar este documento. Referencias legales
> citadas de memoria del equipo — verificar contra el texto vigente de la LIVA/
> RLIVA/RMF antes de activar cualquier cálculo.

## 1. El caso

Un cliente compra una unidad (nueva o seminueva) y entrega su auto usado como
parte del pago («toma a cuenta»). La agencia:

1. Recibe el usado de una **persona física sin actividad empresarial** (el caso
   típico) — no hay CFDI del vendedor.
2. Lo capitaliza a inventario como **seminuevo** y luego lo revende.

Hoy el pedido ya captura la negociación (`tomaACuentaDesc`, `tomaACuentaMonto`)
como dato de control. Este diseño cubre lo que falta: la entrada a inventario,
la documentación de la compra y el IVA de la reventa.

## 2. Tratamiento fiscal (a validar)

### 2.1 La compra del usado (adquisición a persona física)

- **IVA**: la enajenación de bienes muebles usados por personas físicas (salvo
  empresas) está **exenta** — Art. 9, fracción IV, LIVA. La agencia NO paga IVA
  al tomar el auto; no hay IVA acreditable en la compra.
- **Comprobación**: al no haber CFDI del particular, la compra se documenta con
  el esquema de **CFDI a través del adquirente** (RMF, expedición de CFDI por
  compras a personas físicas — vía un PCECFDI) **o**, en la práctica común del
  sector, con el expediente de compra: contrato de compraventa, identificación
  oficial del vendedor, factura de origen endosada, comprobante del pago.
- **Deducibilidad ISR (Art. 27 LISR)**: pago con transferencia/cheque
  nominativo (los pagos > $2,000 en efectivo no son deducibles), expediente
  completo, y el bien registrado en contabilidad (nuestro inventario de
  unidades ya lo hace).
- **ISAN**: no aplica — grava solo automóviles nuevos.

### 2.2 La reventa del seminuevo — IVA sobre el margen

- Regla general: IVA sobre el precio total de venta.
- **Excepción clave del sector (Art. 27 RLIVA)**: quien enajena autos usados
  **adquiridos de personas físicas que no trasladaron IVA** puede calcular el
  IVA sobre la **diferencia entre el precio de venta y el costo de
  adquisición** (el margen), cumpliendo requisitos: compra documentada con el
  expediente del §2.1, pago trazable, y registro del vehículo en contabilidad.
- Consecuencia: vender en $180,000 un usado tomado en $150,000 causa IVA sobre
  $30,000 (≈$4,800), no sobre $180,000 (≈$28,800). **No aplicar la excepción
  regala ~$24,000 por unidad** en este ejemplo — es la diferencia competitiva
  de un lote bien administrado.
- Si el usado se compró a otra empresa (con CFDI e IVA trasladado), la reventa
  causa IVA sobre el precio total y el IVA de compra fue acreditable — régimen
  normal.

### 2.3 La toma a cuenta en la venta de la unidad nueva

La toma es **pago en especie**: el CFDI de la venta de la unidad nueva se emite
por el precio TOTAL pactado (la base de IVA/ISAN de la nueva no cambia por
recibir un usado). El usado entra como forma de pago (FormaPago 27 «a
satisfacción del acreedor» o la que el contador defina). Contablemente:

```
Venta de la nueva (ya existe, venta.ts):
  CARGO   Clientes                    precio + ISAN + IVA
  ABONO   Ventas / ISAN por pagar / IVA trasladado

Aplicación de la toma (nuevo, al facturar el pedido):
  CARGO   Inventario seminuevos       valor de toma
  ABONO   Clientes                    valor de toma   (paga en especie)
```

El efectivo restante entra por conciliación bancaria, como todo en el sistema.

## 3. Diseño operativo

### 3.1 Alta del seminuevo (IMPLEMENTADO en este PR)

Al ejecutar **facturar** un pedido con `tomaACuentaMonto > 0`, la acción acepta
los datos del usado (`toma: {vin, marca, modelo, anio, kilometraje, color}`) y
crea la unidad en el MISMO flujo:

- `tipo: SEMINUEVO`, `estado: DISPONIBLE`, `uso: VENTA`
- `costoCompra = tomaACuentaMonto` (sin IVA — la compra fue exenta)
- `autoCreado: false`, sin `compraInvoiceId` (patrón ya existente de unidades
  sin CFDI de compra; el costo es editable mientras no haya CFDI)
- `notas` liga el pedido de origen y el cliente que la entregó.

Si el VIN no se captura en ese momento, la unidad NO se crea (VIN es la llave
del expediente) — queda el dato en el pedido y el alta se hace después desde
Inventario. La página de Alertas podrá señalar «tomas a cuenta sin unidad en
inventario» (pendiente).

### 3.2 IVA sobre margen en la venta (PENDIENTE — requiere validación)

Propuesta para `venta.ts` cuando el contador valide §2.2:

- Nuevo campo `Vehiculo.ivaSobreMargen: Boolean` (default `false`), que el alta
  por toma a cuenta prende automáticamente (compra a PF exenta documentada).
- En `ejecutarVentaUnidad`: si `ivaSobreMargen`, la base de IVA es
  `max(0, precioVenta − costoCompra)` en lugar de `precioVenta + ISAN`
  (seminuevos no causan ISAN). El asiento separa el IVA trasladado del margen.
- El CFDI de la reventa se emite conforme al criterio del contador (objeto de
  impuesto / desglose) — fuera del alcance del motor hasta esa definición.

### 3.3 Expediente de compra (PENDIENTE)

Checklist por seminuevo tomado (contrato, INE, factura endosada, comprobante de
pago) como campos/documentos en la unidad — condición de los beneficios del
§2.1/§2.2. Encaja con el patrón de Hallazgos: «seminuevo sin expediente
completo» como alerta.

## 4. Qué NO hace el sistema (por diseño)

- No emite el CFDI de adquisición a través de adquirente (requiere PCECFDI);
  documenta y alerta, el trámite es del contador.
- No decide la forma de pago del CFDI de la nueva — eso es de quien factura.
- No aplica IVA sobre margen hasta que este documento esté validado.
