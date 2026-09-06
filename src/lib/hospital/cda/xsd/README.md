# Esquemas HL7 CDA R2 (XSD)

Copia sin modificar de los esquemas oficiales de **HL7 Clinical Document
Architecture, Release 2** tal como los redistribuye la DGIS en el paquete
`GIIS-A001-01-05.zip` (Guía de Intercambio de Información en Salud —
Resumen Clínico, carpeta `ANEXOS/cda/`). Sólo se conservan los archivos que
`CDA.xsd` necesita para resolver, con sus rutas relativas intactas:

```
CDA.xsd
POCD_MT000040.xsd
processable/coreschemas/datatypes.xsd
processable/coreschemas/datatypes-base.xsd
processable/coreschemas/NarrativeBlock.xsd
processable/coreschemas/voc.xsd
```

Se usan únicamente para validar el XML que genera `src/lib/hospital/cda`
(`resumen-clinico.test.ts` corre `xmllint --noout --schema CDA.xsd` cuando la
herramienta está instalada). No se sirven ni se cargan en tiempo de ejecución.

Derechos: HL7 International. El uso de los esquemas está permitido por la
licencia de HL7 para implementar el estándar; el texto de la licencia viene en
el encabezado de `POCD_MT000040.xsd`.
