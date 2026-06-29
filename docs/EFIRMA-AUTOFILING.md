# Auto-presentación con e.firma — Investigación (sellado y envío al SAT)

_Documento de investigación. NO contiene código de aplicación. Última actualización: 2026-06-29._

Este documento evalúa la viabilidad, el riesgo y el camino recomendado para automatizar
el **último paso manual** del ciclo de cumplimiento: **sellar y ENVIAR al SAT** los XML de
Contabilidad Electrónica (CE, Anexo 24) y las declaraciones mensuales/anuales, usando la
**e.firma (FIEL)** del contribuyente (.cer/.key + contraseña).

Conclusión adelantada (ver §7): **NO debemos construir todavía una auto-presentación
totalmente automatizada, y por ahora NO deberíamos custodiar las e.firma de los clientes para
presentar en su nombre.** El SAT no publica un web service de *envío* para que un tercero
presente CE ni declaraciones programáticamente; ambos flujos son **portales web autenticados**.
El siguiente paso correcto es **presentación asistida**: generar el archivo correcto + un acuse
guiado paso a paso para que el contador suba el archivo y capture el acuse — cerrando el lazo
sin asumir el riesgo de manejar llaves privadas ni de suplantar la sesión del contribuyente.

---

## 1. Alcance y estado actual

### Lo que la app YA genera (sin enviar)

| Pieza | Archivo | Estado |
|---|---|---|
| Catálogo de Cuentas (CT, anual / al cambiar) | `src/lib/contabilidad/coe-xml.ts` → `renderCatalogoXml` / `generateCatalogoXml` | Genera XML válido contra `CatalogoCuentas_1_3.xsd` (Anexo 24 v1.3). |
| Balanza de Comprobación (BCE, mensual) | `src/lib/contabilidad/coe-xml.ts` → `renderBalanzaXml` / `generateBalanzaXml` | Genera XML; decide N/C automáticamente (`coe-envio.ts`). |
| Pólizas del Periodo (PL, a solicitud del SAT) | `src/lib/contabilidad/coe-polizas.ts` | Genera XML con `CompNal` (UUID/RFC/monto). |
| Auxiliares de cuenta / folios | `src/lib/contabilidad/coe-auxiliares.ts` | Genera XML. |
| Declaraciones (ISR provisional, IVA, anual PF, regímenes) | `src/lib/impuestos.ts`, `src/lib/fiscal/*` | Calcula la **posición fiscal** (montos a pagar/saldo a favor). |
| Captura de acuses de declaración | `src/lib/fiscal/acuse/parse.ts`, `/api/declaraciones/save`, página `/declaraciones` | El usuario sube el **PDF del acuse**; la app lo parsea y guarda (HANDOFF §14). |
| Estado de la e.firma | `src/lib/fiel.ts` (`fielStatus`), `src/lib/sat-fiel.ts` (`getFielForCompany`) | Detecta vigencia/vencimiento. La FIEL **ya se usa** para descarga masiva (`@nodecfdi/sat-ws-descarga-masiva`). |

Nota importante: la app **ya almacena `fielCer`, `fielKey`, `fielPassword`** cifrados en reposo
(`src/lib/crypto.ts`) y los usa para la **descarga masiva de CFDI** (un web service del SAT que
SÍ existe y SÍ se autentica con e.firma). Es decir, el patrón "tener la llave y autenticarse"
ya está en producción para *lectura*. El salto a *escritura/presentación* es de otra naturaleza
de riesgo (ver §4).

### Lo que sigue siendo manual

1. **Sellado** del XML de CE con e.firma (el Anexo 24 exige `Sello`, `Certificado`,
   `noCertificado` en el nodo raíz de cada archivo CT/BCE/PL — hoy `coe-xml.ts` **no** emite
   estos atributos; los XML que generamos son el *contenido*, no el documento sellado y listo
   para enviar).
2. **Envío** de CE al SAT (subir el .zip al portal "Envía tu Contabilidad Electrónica").
3. **Presentación** de declaraciones mensuales/anuales (portal "Declaraciones y Pagos" /
   "Mi Contabilidad", obtención de la **línea de captura**).
4. **Captura del acuse** (hoy se sube el PDF a mano; §14 del HANDOFF).

---

## 2. Canales de envío del SAT y su automatizabilidad

### 2.1 Contabilidad Electrónica (CT/BCE/PL)

- **Canal real:** portal autenticado **"Envía tu Contabilidad Electrónica"**
  (https://www.sat.gob.mx/portal/public/tramites/contabilidad-electronica,
  app https://www.sat.gob.mx/aplicacion/login/42150/envia-tu-contabilidad-electronica),
  accesible desde el **Buzón Tributario**. Se sube un **.ZIP** con los XML (nomenclatura
  `RFC + Anio + Mes + Tipo` definida en el Anexo 24), **firmado con e.firma vigente**. El sistema
  devuelve un **acuse** con folio, fecha/hora, RFC, periodo, nombre de archivo, tipo de archivo,
  tipo de envío y estado (aceptado/rechazado).
  Fuentes: [SAT — Envío de contabilidad electrónica](https://www.sat.gob.mx/portal/public/tramites/contabilidad-electronica),
  [SAT/gob.mx — Contabilidad electrónica](https://www.gob.mx/sat/acciones-y-programas/contabilidad-electronica-173700),
  [Anexo técnico — Contabilidad en medios electrónicos](https://www.gob.mx/cms/uploads/attachment/file/154200/Doc_tecnico_Cont_Electronica.pdf).

- **¿Hay web service / SOAP/REST documentado para ENVIAR?**
  **No para el contribuyente/terceros de forma general.** El SAT publica un *esquema XML de
  comunicación* y el **Anexo técnico de Contabilidad en medios electrónicos** describe la
  estructura del archivo y del acuse, pero el **envío** es vía portal/Buzón. Existe un servicio
  de envío **masivo/automático** que el SAT ha ofrecido a contribuyentes de alto volumen
  (modalidad por web service), pero está sujeto a habilitación/convenio y no es una API pública
  con documentación abierta de endpoints estables. **No debemos asumir ni inventar endpoints.**
  Los web services del SAT que sí están documentados y son públicos son de **lectura/validación**,
  no de presentación:
  - **Descarga masiva de CFDI** (la que ya usamos).
  - **Validación de CFDI / verificación de comprobantes**
    ([doc. SAT](https://www.sat.gob.mx/cs/Satellite?blobcol=urldata&blobkey=id&blobtable=MungoBlobs&blobwhere=1461175779527&ssbinary=true)).

  **Implicación:** automatizar el envío de CE implicaría **automatización de navegador**
  (headless) impersonando la sesión del contribuyente en el portal — frágil (cambios de UI,
  CAPTCHAs, MFA, posibles cláusulas de uso) y de riesgo legal/operativo alto. No es un web
  service contractual.

- **Cadencia:** CT (catálogo) al año o cuando cambia; BCE (balanza) **mensual**; PL (pólizas)
  **a solicitud** (auditoría AF/FC, devolución DE, compensación CO) — ya modelado en
  `coe-polizas.ts::TipoSolicitud`.

### 2.2 Declaraciones mensuales (IVA / ISR / DIOT) y anual

- **Canal real:** **portal web autenticado** del SAT, con **declaraciones prellenadas**
  (el SAT ya pre-rellena con los CFDI). Plataformas vigentes (2025+):
  - Pagos provisionales/definitivos PF y PM ("Declaraciones y Pagos" / simuladores)
    ([PF](https://wwwmatnp.sat.gob.mx/declaracion/26984/declaracion-mensual-en-el-servicio-de-declaraciones-y-pagos),
    [PM](https://wwwmat.sat.gob.mx/declaracion/95291/declaracion-mensual-para-tu-empresa-en-el-servicio-de-declaraciones-y-pagos)).
  - **DIOT** — desde 2025 **únicamente** por la **nueva plataforma digital**
    ([aviso SAT 042-2025](https://www.gob.mx/sat/prensa/sat-informa-que-la-diot-debe-presentarse-unicamente-por-medio-de-la-nueva-plataforma-digital-042-2025),
    [nuevas plataformas DIOT y pagos](https://www.gob.mx/sat/prensa/sat-lanza-nuevas-plataformas-para-presentacion-de-diot-y-pagos-provisionales-o-definitivos-06-2025)).
  - **RESICO PF** y anual PF: simuladores/plataformas dedicadas.
  - Acceso con **RFC + Contraseña (CIEC) o e.firma**.
    Fuente: [SAT — Declaraciones](https://wwwmat.sat.gob.mx/personas/declaraciones).
- **Flujo de línea de captura:** al presentar, el portal genera el **acuse** y, si hay impuesto a
  cargo, una **línea de captura** (referencia de pago con vigencia). El pago se hace en el banco
  con esa referencia.
- **¿API de presentación?** **No.** No existe un web service público para presentar
  declaraciones por un tercero. El flujo es exclusivamente portal. Igual que en CE, automatizar
  esto sería automatización de navegador sobre la sesión del contribuyente.

**Resumen §2:** para **ambos** flujos (CE y declaraciones) el SAT ofrece **solo portales web
autenticados**; **no** un API de *envío* documentada y pública. Lo que sí existe como API es
**extracción/validación** (descarga masiva, validación CFDI). Esto es decisivo para la
recomendación (§7).

---

## 3. Uso programático de la e.firma (sellado / firmado)

### 3.1 ¿Se puede sellar/firmar un payload server-side con .cer/.key?

**Sí, técnicamente.** La e.firma es un par de claves X.509 (igual que un CSD). Con el `.key`
(clave privada PKCS#8, normalmente cifrada con la contraseña) se puede:

- Calcular el **sello** del XML de CE: SHA-256 sobre la **cadena original** del documento,
  cifrada con RSA con la clave privada, en Base64; y emitir `Certificado` (el .cer en Base64) y
  `noCertificado` (el número de serie del certificado) en el nodo raíz. El Anexo 24 define estos
  tres atributos para CT/BCE/PL. Node ya tiene todo lo necesario (`crypto`, `X509Certificate`);
  de hecho `src/lib/fiel.ts` ya parsea el .cer.
- Autenticarse ante web services del SAT (ya lo hacemos para descarga masiva vía
  `@nodecfdi/sat-ws-descarga-masiva`, que firma el token SOAP con la FIEL).

**Pero sellar ≠ enviar.** Sellar produce el archivo *aceptable*; el SAT lo **recibe** solo por
el portal/Buzón (§2). Sellar server-side **no** elimina el paso manual de subida; solo deja el
.zip listo. Por tanto, **el sellado server-side tiene valor incluso en el camino asistido**
(generar el .zip ya sellado para que el contador solo lo suba), **sin** necesidad de custodiar
la llave de forma permanente (§4: la contraseña/llave puede pedirse por envío).

### 3.2 Sello digital (CSD) vs e.firma (FIEL) — no confundir

| | **e.firma (FIEL)** | **CSD (Certificado de Sello Digital)** |
|---|---|---|
| Propósito | **Identificar** al contribuyente en trámites ante el SAT (presentar declaraciones, Buzón, descarga masiva, **sellar CE**). | **Sellar CFDI** (facturas) exclusivamente. |
| Quién lo usa | El contribuyente / su representante legal. | El PAC al timbrar el CFDI. |
| Archivos | `.cer` + `.key` + contraseña. | `.cer` + `.key` + contraseña. |
| En esta app | `fielCer/fielKey/fielPassword` (descarga masiva, y sería para CE/declaraciones). | Se delega al **PAC** (Facturapi / SW Sapien) — la app **no** sella CFDI. |

Fuentes: [Enlace Fiscal — FIEL vs CSD](https://soporte.enlacefiscal.com/article/13-diferencia-entre-fiel-y-csd),
[El Contribuyente — diferencias e.firma y CSD](https://www.elcontribuyente.mx/2024/01/cuales-son-las-diferencias-entre-la-e-firma-y-el-csd-del-sat/),
[Facturama — FIEL vs CSD](https://facturama.mx/blog/sellos-digitales-diferencias-fiel-csd-principiantes/).

**Punto clave de seguridad:** la e.firma es **mucho más sensible** que un CSD. Con la e.firma se
puede **presentar declaraciones, cambiar el domicilio, generar/revocar CSD, abrir el Buzón,
realizar trámites legales** — en la práctica, **suplantar fiscalmente** al contribuyente. Un CSD
comprometido "solo" permite emitir facturas falsas (grave, pero acotado). **Custodiar e.firma es
custodiar la identidad fiscal completa del cliente.**

---

## 4. Custodia de la clave privada y seguridad (sé honesto)

**Esta es la sección decisiva. La recomendación es: por defecto, NO custodiar la e.firma de los
clientes para presentar en su nombre.**

### Riesgos de tener la `.key` + contraseña de los clientes

- **Suplantación fiscal total:** quien tenga `.key` + contraseña **es** el contribuyente ante el
  SAT (presentar, modificar datos, generar CSD, etc.). No es "una credencial más".
- **Superficie de ataque concentrada:** un solo despacho acumularía decenas/cientos de e.firma
  (HANDOFF §13 menciona ~60 empresas) → blanco de altísimo valor. Una brecha = compromiso fiscal
  masivo de todos los clientes a la vez.
- **Responsabilidad legal:** si se presenta algo erróneo, fuera de plazo, o se filtra la llave, la
  exposición legal/reputacional recae sobre nosotros y sobre el despacho. Cifrar en reposo
  (lo que hoy hacemos) reduce el riesgo de robo del *blob*, pero **no** elimina el riesgo de
  uso indebido por la propia app/credenciales de la app, ni la responsabilidad civil.
- **Estado actual:** ya guardamos `fielKey/fielPassword` cifradas para descarga masiva. Eso es
  **lectura**; el límite ético/legal/operativo se cruza al pasar a **presentar/firmar
  obligaciones** en nombre del cliente.

### Alternativas, de menor a mayor riesgo

1. **Nunca almacenar para presentar — subida por envío (recomendado a corto plazo).** El cliente
   sube `.key`/contraseña **solo en el momento de cada presentación**; se usa en memoria, se sella,
   y se descarta (no se persiste). Reduce la ventana de exposición a segundos.
2. **El cliente presenta (asistido).** La app genera el archivo sellable o el .zip y **guía** al
   usuario a subirlo en el portal del SAT; la app captura el acuse. **Cero custodia de llave para
   envío.** (Ya tenemos media pieza: captura de acuse en §14 del HANDOFF.)
3. **Contraseña/CIEC en lugar de e.firma** donde el SAT lo permita (varias declaraciones aceptan
   CIEC). Sigue siendo sensible, pero **no** es la identidad criptográfica total; ya guardamos CIEC
   para Syntage. Aun así, **presentar** con CIEC en nombre del cliente conserva el problema de
   automatización de portal y de responsabilidad.
4. **Custodia en hardware/KMS (HSM/Cloud KMS).** Si algún día hubiera un canal de *envío* legítimo
   por API y el negocio lo justificara, las llaves deberían vivir en un HSM/KMS con operaciones de
   firma auditadas, separación de funciones, consentimiento explícito por operación y registro
   inmutable. **Sigue sin resolver la responsabilidad legal de presentar en nombre del cliente.**
5. **Autoridad delegada / Buzón Tributario.** Explorar si el SAT ofrece una figura de
   **autorización/representación** que permita a un tercero operar sin custodiar la e.firma del
   contribuyente (ver §6). Es el camino "correcto" si existe y aplica.

### Veredicto

**No deberíamos sostener las e.firma de los clientes para auto-presentar.** El upside (ahorrar
una subida manual) no compensa el downside (custodiar la identidad fiscal total de cada cliente,
con responsabilidad legal por presentaciones automáticas). Mantener lo de hoy (e.firma cifrada
**solo para descarga/lectura**) y avanzar hacia **presentación asistida** (§7).

---

## 5. ¿Qué ofrecen Syntage o los PAC para el ENVÍO?

### Syntage (nuestro proveedor de datos, docs.syntage.com)

- **Extracción/lectura, no envío.** El cliente (`src/lib/fiscal/cumplimiento/syntage/client.ts`)
  usa extractores: `tax_compliance`, `tax_status`, `annual_tax_return`, `monthly_tax_return`,
  `invoice`, `tax_retention`, **`electronic_accounting`** (lee CT/BCE/PL **ya enviados** al SAT).
  La doc de Syntage describe la plataforma como acceso a **datos** de fuentes mexicanas
  (SAT/RPC/RUG/etc.), **no** como un servicio para **presentar/enviar** obligaciones.
  Fuente: [docs.syntage.com](https://docs.syntage.com), [Syntage — FAQs](https://syntage.com/recursos/faqs).
- Es decir: Syntage puede confirmar **que** se envió una CE/declaración (y descargar lo enviado),
  pero **no** la envía por nosotros. Útil para **cerrar el lazo de verificación** (¿ya quedó
  presentado?), no para automatizar el envío.

### PAC (Facturapi / SW Sapien)

- Los PAC **timbran CFDI** (sellan con CSD vía el PAC). **No** presentan CE ni declaraciones.
  La app ya delega timbrado al PAC (`src/lib/pac/*`, `src/lib/facturas/stamp.ts`); eso es CFDI,
  un dominio distinto (§3.2).
- Algunos proveedores comerciales (p.ej. EDICOM y otros) ofrecen **envío de CE** como **servicio
  gestionado**, no como API pública neutra; típicamente operan con la e.firma del cliente bajo
  convenio. Eso reintroduce el problema de custodia (§4) y la dependencia de un tercero.

**Conclusión §5:** **nadie en nuestro stack ofrece un API de *envío* de CE o declaraciones.**
Syntage es extracción; los PAC son CFDI. El envío sigue siendo portal/Buzón.

---

## 6. Marco legal/regulatorio

- **Presentar en nombre de un tercero** requiere **representación legal** (poder notarial) o las
  figuras de autorización que el SAT contemple; un contador externo, por sí solo, no es
  representante legal del contribuyente. La **firma del contribuyente o de su representante
  legal** es requisito de validez de la declaración (CFF; las declaraciones pueden rechazarse si
  no la contienen).
  Fuentes: [Código Fiscal de la Federación (CFF)](http://www.diputados.gob.mx/LeyesBiblio/pdf/CFF.pdf),
  [CFF arts. 18–32-I (derechos y obligaciones)](https://mexico.justia.com/federales/codigos/codigo-fiscal-de-la-federacion/titulo-segundo/capitulo-unico/).
- **Términos de la e.firma:** la e.firma es **personal e intransferible**; su uso por un tercero
  sin facultades es jurídicamente problemático y puede acarrear responsabilidad. Compartir/operar
  la e.firma de un cliente para presentar implica asumir que existe mandato suficiente y registro
  del consentimiento por cada acto.
- **Implicación:** una auto-presentación totalmente automática (sin acto explícito del
  contribuyente por presentación) es un terreno legal delicado. Debe, como mínimo: (a) basarse en
  un **mandato/poder** documentado; (b) registrar **consentimiento por operación**; (c) dejar
  **bitácora inmutable** de qué se presentó, cuándo y con qué credencial. Aun cumpliendo esto, el
  beneficio marginal sobre la presentación asistida es bajo frente al riesgo (§4, §7).

> Esta sección es orientativa, no asesoría legal. Antes de cualquier camino que presente en
> nombre del cliente, validar con un fiscalista/abogado y formalizar mandatos por escrito.

---

## 7. Recomendación por fases (con riesgos) y SIGUIENTE paso

### Recomendación general

**No construir auto-presentación totalmente automatizada todavía**, y **no custodiar e.firma de
clientes para presentar**. Razones: (1) el SAT no ofrece API de envío pública → la única
"automatización" sería scraping de portal, frágil y de riesgo; (2) custodiar e.firma = custodiar
la identidad fiscal total del cliente, con responsabilidad legal desproporcionada al beneficio.

### Fases

**Fase 0 — Sellado server-side del XML de CE (bajo riesgo, alto valor).**
Extender `coe-xml.ts`/`coe-polizas.ts` para emitir `Sello`/`Certificado`/`noCertificado` con la
e.firma, **firmando solo cuando el usuario aporta la llave en el momento** (sin persistir). Resultado:
un .zip de CE **ya sellado** y nomenclado, listo para subir. *Riesgo:* manejo en memoria de la
llave por envío — mitigable (no persistir, borrar tras usar). *No* cruza la línea de custodia
permanente.

**Fase 1 — Presentación ASISTIDA (SIGUIENTE PASO RECOMENDADO).**
Para CE y declaraciones: la app (a) genera el archivo/.zip correcto (o muestra los montos
prellenados a capturar), (b) abre/enlaza el portal del SAT correcto, (c) **guía paso a paso** la
subida/captura, y (d) **captura el acuse** (ya existe la mecánica: §14 HANDOFF, `acuse/parse.ts`,
`/declaraciones`). Cierra el lazo **sin** custodiar llaves para envío ni scrapear. *Riesgo:* bajo;
el contribuyente realiza el acto. *Valor:* elimina el trabajo de armar/nombrar archivos y deja
trazabilidad del acuse. **Aquí debe ir el esfuerzo.**

**Fase 2 — Verificación automática del envío (Syntage).**
Tras la presentación asistida, usar el extractor `electronic_accounting` / `*_tax_return` de
Syntage para **confirmar** que el SAT registró la CE/declaración y reconciliar contra lo guardado.
*Riesgo:* bajo (solo lectura). Convierte "presentado a mano" en "verificado por el sistema".

**Fase 3 — (Solo si el negocio lo exige y con respaldo legal) envío automatizado.**
Únicamente si: (a) aparece un canal de *envío* legítimo (API del SAT o convenio formal), (b)
existe **mandato/poder** documentado por cliente, (c) la e.firma se opera vía **HSM/KMS** con
consentimiento por operación y bitácora inmutable. Hasta entonces, **descartado**. *Riesgo:* alto
(legal, seguridad, fragilidad). El scraping de portal **no** se recomienda como sustituto.

### Siguiente paso concreto

Implementar **Fase 0 + Fase 1** como un único flujo de **"presentación asistida de Contabilidad
Electrónica"**: generar el .zip CT/BCE sellado en el momento (llave aportada por envío, no
persistida), guiar la subida al portal "Envía tu Contabilidad Electrónica", y registrar el acuse.
Replicar el patrón para declaraciones (montos prellenados → guía → captura de acuse → verificación
Syntage). **No** abrir un camino que persista e.firma para presentar.

---

## Fuentes

- SAT — Envío de contabilidad electrónica: https://www.sat.gob.mx/portal/public/tramites/contabilidad-electronica
- SAT — App "Envía tu Contabilidad Electrónica": https://www.sat.gob.mx/aplicacion/login/42150/envia-tu-contabilidad-electronica
- gob.mx/SAT — Contabilidad electrónica (programa): https://www.gob.mx/sat/acciones-y-programas/contabilidad-electronica-173700
- SAT — Anexo técnico "Contabilidad en medios electrónicos": https://www.gob.mx/cms/uploads/attachment/file/154200/Doc_tecnico_Cont_Electronica.pdf
- SAT — Doc. del Servicio Web de Verificación de comprobantes: https://www.sat.gob.mx/cs/Satellite?blobcol=urldata&blobkey=id&blobtable=MungoBlobs&blobwhere=1461175779527&ssbinary=true
- SAT — Declaraciones (personas): https://wwwmat.sat.gob.mx/personas/declaraciones
- SAT — Declaración mensual PF (Declaraciones y Pagos): https://wwwmatnp.sat.gob.mx/declaracion/26984/declaracion-mensual-en-el-servicio-de-declaraciones-y-pagos
- SAT — Declaración mensual PM: https://wwwmat.sat.gob.mx/declaracion/95291/declaracion-mensual-para-tu-empresa-en-el-servicio-de-declaraciones-y-pagos
- SAT — DIOT por nueva plataforma (aviso 042-2025): https://www.gob.mx/sat/prensa/sat-informa-que-la-diot-debe-presentarse-unicamente-por-medio-de-la-nueva-plataforma-digital-042-2025
- SAT — Nuevas plataformas DIOT y pagos (06-2025): https://www.gob.mx/sat/prensa/sat-lanza-nuevas-plataformas-para-presentacion-de-diot-y-pagos-provisionales-o-definitivos-06-2025
- Enlace Fiscal — Diferencia FIEL vs CSD: https://soporte.enlacefiscal.com/article/13-diferencia-entre-fiel-y-csd
- El Contribuyente — Diferencias e.firma y CSD: https://www.elcontribuyente.mx/2024/01/cuales-son-las-diferencias-entre-la-e-firma-y-el-csd-del-sat/
- Facturama — FIEL vs CSD: https://facturama.mx/blog/sellos-digitales-diferencias-fiel-csd-principiantes/
- Syntage — Documentación: https://docs.syntage.com
- Syntage — FAQs: https://syntage.com/recursos/faqs
- Código Fiscal de la Federación (CFF): http://www.diputados.gob.mx/LeyesBiblio/pdf/CFF.pdf
- CFF arts. 18–32-I (Justia): https://mexico.justia.com/federales/codigos/codigo-fiscal-de-la-federacion/titulo-segundo/capitulo-unico/

> Nota de incertidumbre: el SAT no documenta públicamente un web service de *envío* de CE o
> declaraciones para terceros; la existencia de modalidades de envío masivo por convenio no está
> confirmada con endpoints abiertos y **no debe asumirse**. Cualquier afirmación sobre un API de
> envío debe verificarse contra documentación oficial vigente antes de construir sobre ella.
