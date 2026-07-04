# Tokens de API para satélites — access corto + refresh rotatorio

Guía para las aplicaciones satélite (padel/theclubpadel, bartiz, FlotaGob,
ZionX) que consumen la API de contabilidad-os con `Authorization: Bearer`.

Desde julio de 2026 el flujo recomendado emite un **access token de 1 hora**
más un **refresh token opaco de 30 días con rotación**. El token legado de
7 días queda deprecado: los ya emitidos siguen funcionando hasta expirar,
pero emitir nuevos requiere la bandera `LEGACY_API_TOKENS_ENABLED="true"` en
el servidor y `{ "legacy": true }` en el body.

Los tokens de socios del club de pádel (`/api/padel/auth/token`, audiencia
`theclubpadel:member`) NO cambian.

## 1. Iniciar sesión

```bash
curl -X POST https://<host>/api/auth/token \
  -H "Content-Type: application/json" \
  -d '{
    "email": "robot@satelite.mx",
    "password": "...",
    "cliente": "bartiz-construccion",
    "scope": "clientes facturas"
  }'
```

- `cliente` (opcional pero recomendado): etiqueta con la que el acceso
  aparece en Configuración → Mi cuenta → Accesos de API. Sin él se usa el
  User-Agent.
- `scope` (opcional): scopes separados por espacio. Hoy se aplican en
  `clientes` (/api/clientes), `facturas` (POST /api/facturas) y `nomina`
  (POST /api/nomina/emit). **Un token SIN scope conserva acceso total**
  (comportamiento histórico); con scope, las rutas fuera del alcance
  responden 403.

Respuesta 200:

```json
{
  "token": "<JWT de 1 hora>",
  "refreshToken": "<secreto opaco de 30 días>",
  "expiresIn": 3600,
  "refreshExpiresIn": 2592000,
  "user": { "id": "...", "email": "...", "name": "..." },
  "companies": [ { "id": "...", "rfc": "...", "razonSocial": "...", "role": "...", "modulos": ["..."] } ]
}
```

Usa `token` en el encabezado `Authorization: Bearer <token>` como siempre.
Guarda `refreshToken` en un lugar seguro (equivale a la sesión completa).

## 2. Renovar antes de que expire el access token

```bash
curl -X POST https://<host>/api/auth/token/refresh \
  -H "Content-Type: application/json" \
  -d '{ "refreshToken": "<el refreshToken vigente>" }'
```

Respuesta 200: `{ token, refreshToken, expiresIn, refreshExpiresIn }`.

Reglas de rotación (importantes):

1. **Cada renovación devuelve un `refreshToken` NUEVO.** Sustituye el
   anterior de inmediato y descártalo; el viejo queda revocado.
2. **Reutilizar un refresh token viejo revoca la cadena completa** (detección
   estándar de robo) y responde 401. Si eso pasa, vuelve a iniciar sesión con
   credenciales. Implicación práctica: no compartas el mismo refresh token
   entre procesos/réplicas — cada instancia debe iniciar su propia sesión.
3. Ante cualquier 401 del refresh (expirado, revocado desde la UI, cadena
   revocada), el remedio es siempre el mismo: `POST /api/auth/token` de nuevo.

## 3. Revocación

- UI: Configuración → Mi cuenta → «Accesos de API», botón «Revocar» (o
  «Revocar todos»).
- API: `GET /api/me/tokens` lista los accesos activos del usuario;
  `DELETE /api/me/tokens` con body `{ "id": "<tokenId>" }` o
  `{ "todos": true }` los revoca.

Al revocar, la renovación falla de inmediato; el último access token emitido
caduca solo en menos de 1 hora (por eso no hay denylist de `jti`). La palanca
de emergencia global sigue siendo rotar `AUTH_SECRET`.

## 4. Receta de migración por satélite

1. Añade `cliente` (etiqueta) y, si aplica, `scope` al login existente.
2. Guarda el par `{ token, refreshToken }` en vez de sólo `token`.
3. Programa la renovación: al recibir 401 en cualquier llamada, o
   proactivamente cada ~50 minutos, llama a `/api/auth/token/refresh` y
   sustituye AMBOS valores.
4. Maneja el 401 del refresh volviendo al login con credenciales.
5. Mientras migras, puedes pedir el token de 7 días con `{ "legacy": true }`
   — sólo funciona si el servidor tiene `LEGACY_API_TOKENS_ENABLED="true"`,
   y quedará deshabilitado una vez migrados todos los satélites.

## 5. Bitácora

Eventos registrados en la bitácora de seguridad (AuditLog): `token.emitir`
(login, incluye etiqueta/scope/legacy), `token.revocar` (revocación desde
UI/API) y `token.refresh-reuso` (detección de reutilización/robo).
