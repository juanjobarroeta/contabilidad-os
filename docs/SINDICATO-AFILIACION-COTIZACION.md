# Cotización — Plataforma de afiliación sindical (landing + WhatsApp + INE)

**Estado:** borrador de cotización para prospecto (sindicato en México).
**Fecha:** 27 de agosto de 2026. **Vigencia:** 30 días naturales.
**Preparada para:** [Nombre del sindicato]. **Preparada por:** [Tu nombre / empresa].

---

## 1. Qué se cotiza

Una plataforma web de afiliación para el sindicato. El flujo del trabajador:

1. El sindicato comparte una **liga** (por WhatsApp, volante con QR, etc.).
2. El trabajador abre la **landing page** con la identidad del sindicato.
3. **Validación por WhatsApp**: captura su número de teléfono y recibe un
   código de un solo uso (OTP) por WhatsApp; al confirmarlo queda verificado
   que el teléfono es real y suyo.
4. **Formulario de afiliación**:
   - Nombre completo
   - Fecha de nacimiento
   - Número de teléfono (ya verificado en el paso anterior)
   - Fecha en que comenzó a trabajar
5. **Fotografía de su credencial INE** (frente y reverso) con guía de cámara
   (encuadre, enfoque, luz) y validación de calidad al momento.
6. Del reverso de la INE se **extrae la firma** del trabajador como imagen
   limpia (PNG con fondo transparente), lista para usarse en el formato de
   afiliación / padrón del sindicato.
7. El sindicato administra todo desde un **panel**: lista de afiliados,
   revisión de cada registro, descarga de firmas e INEs, exportación a
   Excel/CSV.

## 2. Alcance detallado

### Landing page
- Diseño a la identidad del sindicato (logo, colores, fotografía).
- Contenido: quiénes somos, beneficios de afiliarse, llamado a la acción.
- Responsive (el 95%+ del tráfico será desde celular, llegando por WhatsApp).
- Liga única del sindicato; opcional: ligas por sección/delegación para saber
  por dónde llegó cada afiliado.

### Verificación por WhatsApp (OTP)
- Integración con la **API oficial de WhatsApp** (Meta Cloud API) con plantilla
  de autenticación aprobada; alternativa: Twilio Verify.
- Reintentos, expiración del código, y protección anti-abuso (rate limiting,
  bloqueo de números repetidos).
- El número verificado queda como dato de contacto confiable del padrón.

### Formulario de afiliación
- Los 4 campos acordados con validaciones (mayoría de edad, fechas coherentes,
  formato de teléfono a 10 dígitos).
- Detección de duplicados (mismo teléfono ya afiliado).
- Guardado progresivo: si el trabajador se interrumpe, puede retomar con su
  mismo número sin volver a capturar todo.

### Captura de INE y extracción de firma
- Captura guiada de frente y reverso con revisión de calidad (borrosa, con
  reflejo, incompleta → se pide de nuevo al momento).
- Pipeline de extracción de firma: detección de la credencial en la foto,
  corrección de perspectiva, localización de la zona de firma según el modelo
  de credencial, recorte, limpieza de fondo → **PNG transparente**.
- **Revisión humana en el panel**: cada firma extraída se puede aprobar o
  re-recortar manualmente con una herramienta de recorte. La extracción
  automática acelera; la revisión garantiza calidad del padrón.

### Panel de administración
- Acceso con usuario/contraseña para el sindicato (roles: admin y capturista).
- Lista de afiliados con búsqueda y filtros; detalle por afiliado con sus
  datos, fotos de INE y firma extraída.
- Estados de revisión (pendiente / aprobado / rechazado con motivo).
- Exportación a Excel/CSV del padrón; descarga masiva de firmas.

### Seguridad y cumplimiento (LFPDPPP)
- **Aviso de privacidad** en la landing y consentimiento expreso con evidencia
  (fecha, hora, número verificado). El sindicato es el responsable del
  tratamiento; nosotros entregamos la plataforma que lo documenta.
- Imágenes de INE y firmas en almacenamiento privado cifrado; nunca en URLs
  públicas. Acceso solo desde el panel autenticado, con bitácora de accesos.
- Política de retención y borrado a definir con el sindicato.

## 3. Paquetes y precio

| Concepto | Paquete A — Esencial | Paquete B — Completo |
|---|---|---|
| Landing page con identidad del sindicato | ✔ | ✔ |
| Verificación por WhatsApp (OTP) | ✔ | ✔ |
| Formulario de afiliación (4 campos, validaciones, duplicados) | ✔ | ✔ |
| Captura INE frente/reverso con guía y control de calidad | ✔ | ✔ |
| Extracción de firma | Recorte **manual** en el panel (herramienta de recorte) | **Automática** + revisión/ajuste manual |
| Panel de administración | Lista, detalle, export CSV | + roles, estados de revisión, export Excel, descarga masiva de firmas |
| Ligas por sección/delegación | — | ✔ |
| Aviso de privacidad + consentimiento con evidencia | ✔ | ✔ |
| Despliegue, dominio, monitoreo de errores | ✔ | ✔ |
| **Tiempo de entrega** | **3–4 semanas** | **5–6 semanas** |
| **Inversión (MXN + IVA)** | **$58,000** | **$89,000** |

> Los precios son ajustables según negociación; son el punto de partida
> sugerido. Ambos paquetes incluyen 30 días de garantía sobre defectos
> posteriores a la entrega.

### Costos recurrentes (a cargo del sindicato, aprox.)
- Infraestructura (hosting + base de datos + almacenamiento): **US$25–50/mes**.
- Mensajes de WhatsApp (plantilla de autenticación, tarifa Meta México):
  **≈ $0.50–1.00 MXN por verificación** (solo se paga por registro real).
- Dominio: ≈ $350 MXN/año.
- Mantenimiento y soporte opcional: **$3,500 MXN/mes** (actualizaciones,
  respaldos, ajustes menores).

### Forma de pago sugerida
50% anticipo · 30% al liberar el flujo completo en ambiente de pruebas ·
20% contra entrega en producción.

## 4. Supuestos y exclusiones

**Supuestos**
- El sindicato entrega logo, colores y textos base (o los redactamos juntos en
  una sesión).
- Para la API oficial de WhatsApp se requiere que el sindicato (o quien
  facture) tenga **verificación de negocio en Meta**; el trámite tarda días y
  lo acompañamos. Mientras tanto se puede trabajar con número de pruebas.
- El sindicato es responsable del uso del padrón y las firmas (p. ej. formatos
  de afiliación ante la autoridad laboral); la plataforma captura el
  consentimiento expreso del trabajador para ese uso.

**No incluye** (cotizable por separado)
- App móvil nativa, firma electrónica avanzada (e.firma/NOM-151), verificación
  de la INE contra la Lista Nominal del INE, envío masivo de mensajes de
  WhatsApp (campañas), CRM, ni módulo de cuotas sindicales.

## 5. Arquitectura propuesta (interno)

- **App**: Next.js (mismo stack del hub), Postgres, almacenamiento S3
  compatible privado para imágenes; despliegue en Railway con Sentry.
- **OTP**: Meta WhatsApp Cloud API (plantilla `authentication`); fallback
  Twilio Verify si el WABA se atora.
- **Extracción de firma**: OpenCV (detección de contorno de credencial +
  homografía + zonas por modelo de credencial INE) con limpieza de fondo;
  cola de revisión manual en el panel como red de seguridad. Si el hit-rate
  automático decepciona, el Paquete A (recorte manual) ya es funcional.
- Proyecto **independiente** del hub contable (repo y base de datos propios);
  si el sindicato luego quiere contabilidad de cuotas, se conecta como app
  satélite según `INTEGRATION-GUIDE-SATELLITE-APPS.md`.
