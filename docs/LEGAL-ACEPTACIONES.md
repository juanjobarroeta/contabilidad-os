# Aceptación de documentos legales (evidencia clickwrap)

_Última actualización: 2026-09-03._

## Qué resuelve

Antes, el signup decía «al crear tu cuenta aceptas los Términos» sin checkbox y
sin guardar nada. Un contrato cuya aceptación no se puede probar no protege.
Ahora cada aceptación queda registrada en `LegalAcceptance` (append-only, sin FK
para que sobreviva a la baja de la cuenta/empresa, igual que `AuditLog`):

| Columna | Contenido |
|---|---|
| `userId`, `email` | Quién aceptó (el correo es copia al momento de aceptar). |
| `companyId` | Sólo `MANDATO_EFIRMA`: la empresa cuya e.firma se autoriza. |
| `documento` | `TERMINOS`, `AVISO_PRIVACIDAD` o `MANDATO_EFIRMA`. |
| `version` | Fecha ISO del documento aceptado (= «Última actualización» de la página). |
| `contexto` | `signup`, `gate`, `onboarding` o `configuracion`. |
| `ip`, `userAgent` | De la petición que aceptó. |

## Dónde se pide

| Flujo | Documentos | Cómo se exige |
|---|---|---|
| Crear cuenta (`/signup` → `POST /api/auth/signup`) | Términos + Aviso | Checkbox obligatorio; el servidor rechaza sin `aceptaTerminos: true`. La evidencia se inserta en la **misma transacción** que el usuario. |
| Entrar a la app (`(app)/layout.tsx`) | Términos + Aviso pendientes | `AceptacionLegalGate`: modal bloqueante si falta alguna versión vigente. Cubre cuentas creadas por administradores/satélites y cambios de versión. `POST /api/legal/aceptar`. |
| Cargar e.firma en onboarding (`POST /api/companies`) | Autorización de uso de la e.firma | Checkbox; el servidor rechaza con `MANDATO_EFIRMA_REQUERIDO` si falta. Misma transacción que la empresa. |
| Cargar/reemplazar e.firma en Configuración (`PATCH /api/companies/[id]`) | Autorización de uso de la e.firma | Igual; misma transacción que el `update`. |

El CSD no tiene aceptación propia: la Carta Manifiesto la firma el usuario en
el portal de Facturapi (`facturapiManifiestoAckAt`).

## Cambiar un documento

1. Edita la página en `src/app/legal/<doc>/page.tsx` y su «Última actualización».
2. Sube la versión en `src/lib/legal/documentos.ts` a esa misma fecha.
3. Listo: todo usuario cuya última aceptación sea anterior ve el gate al entrar.

Cambios de redacción menores (typos) **no** deberían subir la versión: cada
subida obliga a todos los usuarios a volver a aceptar.

## Consultar evidencia

`GET /api/admin/legal-aceptaciones?email=...` (o `userId=`, `companyId=`), sólo
operador de plataforma. Devuelve las últimas 200 filas. Sirve para atender una
reclamación o una solicitud ARCO.

## Pendiente de revisión legal

Los textos añadidos el 2026-09-03 son un **borrador** para que un abogado los
valide antes de darlos por definitivos (cada página lo dice en su comentario de
cabecera):

- Términos §3 (e.firma y CSD), §4 (despachos), §9 (indemnización), §10 (límite
  de responsabilidad), §11 (anexo de encargado), §12 (terceros), §14 (evidencia
  y re-aceptación).
- Autorización de uso de la e.firma (`/legal/mandato-efirma`) completa: alcance
  del mandato, usos prohibidos, referencia al CFF, responsabilidad.
- Aviso: referencias a la LFPDPPP vigente (la de 2025 sustituyó a la de 2010 y
  cambió la numeración y la autoridad), datos sensibles en nómina,
  notificación de vulneraciones.

Fuera del alcance de este mecanismo, pero parte del mismo problema:

- Operar como sociedad (SAS/SAPI) en vez de persona física: un contrato limita
  lo que pueden reclamar; una sociedad limita lo que pueden cobrar.
- Seguro de responsabilidad civil profesional / ciber.
- Conservar los contratos con Facturapi, Belvo, Twilio/Meta, Stripe, Anthropic,
  OpenAI, Railway y Syntage.
- No presentar declaraciones con la e.firma de los clientes (ver
  `docs/EFIRMA-AUTOFILING.md` §7): es la línea entre «herramienta» y «actuar
  como ellos», y el mandato la deja por escrito.
