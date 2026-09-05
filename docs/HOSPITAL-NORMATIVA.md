# HospitalOS — normativa, datos que entran y datos que salen

Mapa de lo que la ley y las NOM le exigen a un hospital privado de cirugía
ambulatoria y procedimientos mínimamente invasivos (Haltus Hope, régimen 601,
Puebla) y qué le toca al software: qué capturar, qué conservar, qué producir
y qué reportar. Es el filtro para pulir el módulo ANTES de seguir con el
modelado contable: varias normas cambian el modelo de datos, no sólo la UI.

Leyenda del estado: ✅ ya está en v1 · 🟡 parcial · ❌ falta.

## 1. Mapa normativo

### 1.1 Expediente clínico — NOM-004-SSA3-2012
La norma madre. Aplica a todo establecimiento público, social o privado y a
todo el personal de salud.

| Exige | Le toca al software | Estado |
|---|---|---|
| Un expediente por paciente con ficha de identificación, historia clínica (antecedentes heredofamiliares, personales patológicos y no patológicos, padecimiento actual, exploración física, diagnósticos, pronóstico, plan) | Nota tipo HISTORIA_CLINICA con secciones estructuradas, no texto libre | ❌ (hoy: notas libres) |
| Notas médicas obligatorias: ingreso, evolución, interconsulta, referencia/traslado, **preoperatoria, preanestésica, postoperatoria, postanestésica**, egreso; hoja de enfermería; hoja de urgencias | Tipos de nota completos y plantillas con el contenido mínimo de cada una | 🟡 (faltan PREANESTESICA, POSTANESTESICA, REFERENCIA, hoja de urgencias) |
| Cada nota con fecha, hora, nombre completo, cargo y **firma** de quien la elabora; sin tachaduras ni enmendaduras | Nombre y cédula del autor en cada nota; inmutabilidad (una corrección es una nota nueva) | ✅ inmutable · 🟡 cédula no obligatoria |
| Cartas de consentimiento informado con contenido mínimo (nombre del establecimiento, del paciente, acto autorizado, riesgos y beneficios, firmas del paciente/representante, del médico y de dos testigos, fecha y hora) — obligatorias para ingreso hospitalario, procedimientos quirúrgicos, anestesia, transfusión, investigación… | Documento tipo CONSENTIMIENTO con campos, no sólo «recibido/firmado»; resguardo del PDF firmado | 🟡 (estado sí, contenido y archivo no) |
| Conservación mínima **5 años** a partir del último acto médico | Retención y respaldo; nunca borrar episodios ni notas (sólo cancelar) | 🟡 (sin política de retención explícita) |
| Resumen clínico a petición del paciente; el expediente es del establecimiento, la información es del paciente | Exportar resumen clínico (PDF y CDA, ver NOM-024) | ❌ |

### 1.2 Expediente clínico electrónico — NOM-024-SSA3-2012 (SIRES)
Regula los sistemas que gestionan el expediente electrónico. HospitalOS ES un
SIRES en cuanto guarda notas clínicas.

| Exige | Le toca al software | Estado |
|---|---|---|
| Identificación mínima del paciente: **CURP**, apellidos, nombre, fecha de nacimiento, sexo, nacionalidad, datos geográficos | CURP obligatorio y validado (RENAPO); nacionalidad y entidad; domicilio estructurado | 🟡 (CURP opcional, sin nacionalidad/entidad) |
| Catálogos estandarizados: **CIE-10** (diagnósticos), **CIE-9-MC** (procedimientos), **CLUES** del establecimiento, catálogos de la DGIS | Inyectar catálogos y capturar por catálogo, no en texto | ❌ (diagnosticoCie10 es texto libre) |
| Seguridad: autenticación, autorización por rol, **bitácora de accesos y cambios**, firma electrónica avanzada | Registrar también las LECTURAS del expediente (quién lo abrió); firma con e.firma o firma del sistema con sello de tiempo | 🟡 (bitácora de escrituras sí; lecturas no; firma no) |
| Intercambio: generar el resumen clínico en el estándar de la DGIS (CDA) | Exportador CDA | ❌ |
| Evaluación de conformidad y certificado ante la DGIS | Preparar la cédula de especificaciones cuando el módulo esté completo | ❌ (fase posterior) |

### 1.3 Cirugía mayor ambulatoria — NOM-026-SSA3-2012
**Es el giro del hospital** («centro de procedimientos mínimamente invasivos y
ambulatorios»). Aplica a cada episodio AMBULATORIO con quirófano.

| Exige | Le toca al software | Estado |
|---|---|---|
| Alta en un lapso **no mayor a 12 horas** desde el ingreso, con recuperación anestésica concluida | Reloj del episodio ambulatorio y alerta al acercarse al límite | ❌ |
| Selección del paciente (valoración preoperatoria y preanestésica; clasificación **ASA**) | Campos ASA y valoración en la nota preanestésica | ❌ |
| Consentimiento informado para el procedimiento y la anestesia | Documentos requeridos al programar quirófano (ya se generan) con contenido mínimo | 🟡 |
| Criterios de egreso documentados: recuperación anestésica, respiración espontánea, vía aérea libre, reflejos protectores, dolor controlado (escala **Aldrete** u homóloga) | Checklist de egreso con escala en la nota postanestésica; el alta no se permite sin cumplirla | ❌ |
| Instrucciones de egreso por escrito y seguimiento posterior | Hoja de egreso imprimible y llamada de seguimiento registrada | ❌ |
| Licencia sanitaria y responsable sanitario de la unidad | Guardar número de licencia y responsable en la configuración del hospital | ❌ |

### 1.4 Anestesiología — NOM-006-SSA3-2011
Registro anestésico (hoja de anestesia: técnica, fármacos con dosis y hora,
signos transanestésicos), nota preanestésica y postanestésica firmadas por el
anestesiólogo con cédula de especialidad. **Estado:** ❌ hoja de anestesia; 🟡
notas.

### 1.5 Urgencias — NOM-027-SSA3-2013
Triage con nivel y hora, hoja de urgencias, protocolos homogéneos. Una mala
clasificación es causal de clausura por COFEPRIS. **Le toca:** nivel y hora
de triage en el episodio URGENCIAS, hoja de urgencias como nota obligatoria.
**Estado:** ❌.

### 1.6 Infraestructura, equipamiento y CEYE — NOM-016-SSA3-2012 / NOM-005-SSA3-2010
Programa de mantenimiento preventivo y correctivo del equipo médico y del
inmueble (bitácora); central de esterilización con trazabilidad de ciclos
(indicadores biológicos). **Le toca:** el módulo de Mantenimiento ya cubre
tickets y preventivos (✅); falta inventario de equipo médico con su bitácora
(🟡, el hub tiene activos fijos) y el registro de ciclos de esterilización
ligado a los procedimientos (❌).

### 1.7 Infecciones nosocomiales — NOM-045-SSA2-2005
Vigilancia y notificación (RHOVE). **Le toca:** marcar infecciones asociadas a
la atención en el episodio y exportar el reporte. **Estado:** ❌ (v2).

### 1.8 Sangre y transfusión — NOM-253-SSA1-2012
El hospital factura «BANCO DE SANGRE». Si transfunde, necesita licencia de
servicio de transfusión y registro de cada componente (origen, número de
unidad, receptor, reacciones — hemovigilancia). **Le toca:** cargo de
transfusión ligado a la unidad transfundida y su trazabilidad. **Estado:** ❌.
Pregunta al hospital: ¿transfunde en sitio o sólo intermedia con un banco?

### 1.9 Farmacia hospitalaria y medicamentos controlados
- **FEUM, Suplemento para establecimientos de venta y suministro**: control de
  lote y caducidad (✅ v1), condiciones de almacenamiento y **cadena de frío**
  con registro de temperatura (❌), medicamentos con registro sanitario COFEPRIS
  (🟡: el catálogo derivado no lo trae).
- **Ley General de Salud arts. 226-259 (fracciones I-VI)**: los grupos I y II
  exigen receta especial con código de barras y **libro de control autorizado
  por COFEPRIS**; el grupo III (benzodiacepinas: midazolam) receta ordinaria
  retenida, hasta tres surtidos, registrada en el libro. Las compras se asientan
  con factura, lote y caducidad; se presentan balances a COFEPRIS. **Le toca:**
  campo `grupoControl` (I-VI) en el insumo, la receta o indicación que ampara
  cada salida de controlado, y el **libro de control exportable** por periodo.
  **Estado:** 🟡 (bandera `controlado` sí; grupo, receta y libro no).
- **NOM-249-SSA1-2010 mezclas estériles**: si preparan quimioterapia en sitio
  (los conceptos «servicios oncológicos» y CARBOPLATINO lo sugieren), se
  requiere licencia de centro de mezclas y registro de cada preparación.
  Pregunta al hospital.

### 1.10 Farmacovigilancia y tecnovigilancia — NOM-220-SSA1-2016 / NOM-240-SSA1-2012
Reportar reacciones adversas a medicamentos e incidentes con dispositivos
médicos a COFEPRIS en los plazos de la norma. **Le toca:** formulario de
reporte desde el expediente (medicamento, lote, reacción) y su seguimiento.
**Estado:** ❌ (v2).

### 1.11 Residuos peligrosos biológico-infecciosos — NOM-087-SEMARNAT-SSA1-2002
Bitácora de generación y manifiestos de entrega-transporte-recepción; reporte
semestral según nivel de generación. **Le toca:** bitácora de RPBI por área y
carga de manifiestos. **Estado:** ❌ (v2; puede vivir en Mantenimiento).

### 1.12 Información en salud — NOM-035-SSA3-2012 y vigilancia epidemiológica — NOM-017-SSA2-2012
Obligatoria para el sector privado: reportar al Sistema de Información en
Salud (SINBA): **egresos hospitalarios (SAEH)**, urgencias, consultas y
procedimientos, defunciones (SEED) y nacimientos (SINAC) si aplican;
notificación semanal SUIVE de padecimientos sujetos a vigilancia (NOM-017).
**Le toca:** que el episodio tenga los datos que piden esos formatos (CLUES,
CURP, CIE-10 de ingreso y egreso, CIE-9 del procedimiento, motivo de egreso,
días de estancia) y exportarlos en su formato. **Estado:** ❌ (datos 🟡).

### 1.13 Ley General de Salud y su reglamento en materia de atención médica
- Consentimiento informado (RLGSMPSAM arts. 80-83) y derechos del paciente
  (LGS 51 bis): decidir, información, segunda opinión, resumen clínico.
- Licencia sanitaria (quirófano), aviso de funcionamiento y **responsable
  sanitario**; Carta de los Derechos de los Pacientes visible.
- **Le toca:** guardar licencia, responsable y CLUES en `HospConfig`; el
  portal del paciente (v2) da acceso al resumen y a la cuenta.

### 1.14 Datos personales — LFPDPPP (nueva ley, DOF 20-mar-2025, vigente desde el 21-mar-2025)
Los datos de salud son **sensibles**. Exige aviso de privacidad (integral y
simplificado) desde la captura, consentimiento libre, específico e informado
para el tratamiento, finalidades claras para las **transferencias a
aseguradoras** y médicos externos, derechos ARCO, medidas de seguridad y
registro de vulneraciones. La autoridad ya no es el INAI. **Le toca:** aviso
de privacidad en el alta del paciente con constancia de aceptación (fecha,
versión), finalidad de transferencia por pagador, bitácora de accesos (misma
que NOM-024), portal con ARCO (v2). **Estado:** ❌.

### 1.15 Fiscal específico del hospital (lo que la contabilidad debe respetar)
- **IVA en medicinas**: criterio normativo del SAT 9/IVA/N (Anexo 7 de la
  RMF): las medicinas suministradas **como parte del servicio hospitalario**
  gravan al 16 %; sólo la **venta** de medicinas de patente va al 0 %. El
  hospital ya factura «FARMACIA HOSPITALARIA 16» y «FARMACIA HOSPITALARIA 0»:
  la cuenta del paciente debe decidir por cargo cuál es cuál (PRODECON
  sugirió dejar el criterio sin efectos; sigue vigente).
- **Honorarios médicos**: exentos de IVA sólo cuando los presta una persona
  física (Art. 15-XIV LIVA); si el hospital los cobra a su nombre, gravan. De
  ahí la factura partida: el médico factura lo suyo. Al pagarle a un médico
  persona física, el hospital retiene **10 % ISR y dos terceras partes del
  IVA** (Art. 106 LISR último párrafo, Art. 1-A LIVA) — el módulo de
  honorarios lo cruza contra el CFDI recibido.
- **Uso de CFDI D01** («honorarios médicos, dentales y gastos hospitalarios»)
  para pacientes que deducen; receptor fiscal distinto del paciente permitido.
- **Contabilidad electrónica** (Anexo 24): obligación mensual de una PM 601;
  Haltus no la ha presentado (Syntage lo confirma). El hub la genera.

### 1.16 Laboral (ya en el hub)
Nómina, IMSS (clase de riesgo de hospitales), Infonavit; NOM-035-STPS y
NOM-030-STPS son del área de RH, no del software.

### 1.17 Certificación (voluntaria)
El Consejo de Salubridad General certifica hospitales; las aseguradoras la
piden para convenios. No es ley, pero fija qué evidencia debe producir el
expediente (indicadores, eventos adversos). Conviene diseñar pensando en ella.

## 2. Datos que hay que INYECTAR (catálogos y configuración)

| Dato | Fuente | Para qué |
|---|---|---|
| CIE-10 (diagnósticos) y CIE-9-MC (procedimientos) | DGIS (catálogos oficiales) | Diagnóstico y procedimiento por catálogo en el episodio (NOM-024, SAEH) |
| CLUES del establecimiento, licencia sanitaria, responsable sanitario | Hospital / COFEPRIS | Configuración; encabezado de reportes y CDA |
| CURP (validación) | RENAPO | Identificación única del paciente |
| Catálogo de medicamentos con registro sanitario y **grupo de control** (I-VI) | COFEPRIS / Compendio Nacional de Insumos | Farmacia, libro de control, farmacovigilancia |
| Escalas clínicas: ASA, Aldrete, triage (5 niveles), escala de dolor | Norma / protocolos del hospital | NOM-026, NOM-027, notas |
| Plantillas NOM-004: historia clínica, notas por tipo, consentimientos por procedimiento, hoja de egreso | Redactar con el hospital y su asesor legal | Contenido mínimo garantizado |
| Personal de salud con **cédula profesional** (y de especialidad) | Hospital; Registro Nacional de Profesionistas (SEP) | Firma de notas; honorarios |
| Tabuladores por aseguradora y tope de autorización | Convenios firmados | Cuenta y reparto (ya modelado) |
| Catálogo de camas, quirófanos, salas | Hospital | Censo y agenda (ya modelado; capturar) |
| c_ClaveProdServ y c_UsoCFDI del SAT para servicios hospitalarios | SAT | Facturación (ya en el hub) |

## 3. Datos que hay que CONSERVAR, PRODUCIR y REPORTAR

| Qué | Cadencia / plazo | Destino |
|---|---|---|
| Expediente completo, inmutable, con bitácora de accesos | Conservación ≥ 5 años desde el último acto | Interno; a petición del paciente o autoridad |
| Resumen clínico (PDF y CDA), referencia/traslado | A petición | Paciente, otra unidad |
| Egresos hospitalarios (SAEH), urgencias, consultas, cirugías | Mensual | SIS/SINBA (Secretaría de Salud) |
| SUIVE (padecimientos notificables) | Semanal; inmediata para los urgentes | Vigilancia epidemiológica estatal |
| RHOVE (infecciones nosocomiales) | Mensual | Secretaría de Salud |
| Reacciones adversas (NOM-220) e incidentes con dispositivos (NOM-240) | Plazos de la norma por gravedad | COFEPRIS |
| Libro de control de controlados y balances | Continuo; balances periódicos | COFEPRIS |
| Bitácora y manifiestos de RPBI | Continuo; reporte semestral | SEMARNAT |
| CFDI, complementos de pago, DIOT, contabilidad electrónica, retenciones | Mensual (día 17), CE mensual | SAT (ya en el hub) |
| Aviso de privacidad aceptado, consentimientos firmados | Con cada alta/procedimiento | Interno (evidencia) |

## 4. Lo que cambia en el modelo de HospitalOS (por prioridad)

### P1 — antes de operar con pacientes reales
1. **Paciente**: `curp` obligatorio y validado, `nacionalidad`, `entidadNacimiento`,
   domicilio estructurado, `avisoPrivacidadAceptadoAt` + versión; `expedienteNumero`
   único por paciente.
2. **Episodio**: `diagnosticoIngresoCie10` y `diagnosticoEgresoCie10` por catálogo,
   `procedimientoCie9`, `motivoEgreso` (curación, mejoría, traslado, defunción,
   voluntaria), `triageNivel` + `triageAt` (urgencias), `asa`, `aldreteEgreso`,
   `limiteAmbulatorioAt` (ingreso + 12 h) y alerta.
3. **Notas**: tipos HISTORIA_CLINICA (con secciones), PREANESTESICA,
   POSTANESTESICA, REFERENCIA, HOJA_URGENCIAS, HOJA_ENFERMERIA; `cedula` del
   autor obligatoria para médicos; `hash` + sello de tiempo como firma del
   sistema (e.firma en v2); plantillas con contenido mínimo por tipo.
4. **Documentos**: consentimiento con campos (acto, riesgos, beneficios,
   alternativas, testigos, firmas, fecha/hora) y archivo PDF; hoja de egreso
   con instrucciones; registro anestésico como documento estructurado.
5. **Bitácora de acceso**: registrar lecturas del expediente (usuario, hora,
   episodio) — NOM-024 y LFPDPPP.
6. **Farmacia**: `grupoControl`, `registroSanitario`, `requiereRefrigeracion`;
   salida de controlado exige receta/indicación; **libro de control** exportable.
7. **Configuración**: CLUES, licencia sanitaria, responsable sanitario,
   versión del aviso de privacidad.
8. **Cuenta**: cada cargo de farmacia marca si es suministro en hospitalización
   (16 %) o venta (0 %) — hoy el IVA sale del insumo, no del contexto.

### P2 — para cerrar el círculo con la autoridad
Exportadores SAEH/SIS y SUIVE; RHOVE; formularios de farmacovigilancia y
tecnovigilancia; bitácora de RPBI; trazabilidad de esterilización; transfusión;
resumen clínico CDA y camino a la certificación DGIS; portal del paciente con
ARCO.

### P3
Certificación CSG (indicadores), interoperabilidad con laboratorios/imagen.

## 5. Preguntas para el hospital (cambian el alcance)
1. ¿Licencia sanitaria vigente y responsable sanitario? ¿CLUES?
2. ¿Tienen servicio de urgencias formal (NOM-027) o sólo admisión programada?
3. ¿Transfunden en sitio (NOM-253) o sólo intermedian?
4. ¿Preparan mezclas de quimioterapia en sitio (NOM-249)?
5. ¿Qué medicamentos de grupos I-III manejan; recetarios especiales y libro de control actuales?
6. ¿Aviso de privacidad y consentimientos vigentes (formatos en papel)?
7. ¿Reportan hoy a SINBA/SUIVE? ¿Con qué formatos?
8. ¿Quién firma las notas: médicos con cédula de especialidad, enfermería con cédula?

## 6. Orden recomendado
1. Cerrar P1 en el modelo (una migración) e inyectar los catálogos (CIE-10,
   CIE-9-MC, medicamentos con grupo de control, plantillas).
2. Capturar con el hospital lo configurable (camas, tarifario por convenio,
   personal con cédula, licencias).
3. Entonces sí: apertura contable y modelado fiscal fino (IVA por contexto de
   la farmacia, honorarios, CE).

## Fuentes
- NOM-004-SSA3-2012 — https://dof.gob.mx/nota_detalle_popup.php?codigo=5272787
- NOM-024-SSA3-2012 — https://dof.gob.mx/nota_detalle.php?codigo=5280847&fecha=30%2F11%2F2012 · certificación DGIS: http://www.dgis.salud.gob.mx/contenidos/intercambio/sires_certificacion_gobmx.html
- NOM-026-SSA3-2012 — https://www.dof.gob.mx/nota_detalle.php?codigo=5262609&fecha=07%2F08%2F2012
- NOM-027-SSA3-2013 — https://www.gob.mx/cms/uploads/attachment/file/512073/NOM-027-SSA3-2013.pdf
- NOM-035-SSA3-2012 — https://dof.gob.mx/nota_detalle.php?codigo=5280848&fecha=30%2F11%2F2012 · instructivo SAEH: http://www.dgis.salud.gob.mx/descargas/egresos/pdf/Instructivo_Egresos_Hospitalarios_2023.pdf
- Criterio 9/IVA/N medicinas en hospitales — https://idconline.mx/fiscal-contable/2021/07/22/medicinas-de-patente-sujetas-al-16-de-iva · PRODECON: https://www.gob.mx/prodecon/articulos/sugerencia-al-servicio-de-administracion-tributaria-para-que-enajenacion-de-medicinas-de-patente-en-hospitales-sea-de-0-de-iva
- LFPDPPP 2025 — https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPDPPP.pdf · análisis: https://www.garrigues.com/es_ES/noticia/mexico-nueva-ley-federal-proteccion-datos-personales-posesion-particulares-introduce
- Medicamentos controlados (fracciones, libro de control) — https://pulpos.com/blog/medicamentos-controlados-cofepris-farmacia/
