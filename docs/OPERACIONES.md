# Operaciones — respaldos, esquema y recuperación

> Runbook mínimo de producción (Railway). Actualízalo cuando cambie la
> infraestructura. Contexto: la base guarda datos fiscales de terceros y
> credenciales cifradas (e.firma/CSD); perderla no es recuperable con
> "volver a sincronizar" — los estados de cuenta subidos, conciliaciones,
> declaraciones guardadas y nómina no viven en el SAT.

## 1. Respaldos (pendiente de verificar — hazlo una vez y documenta aquí)

Railway Postgres incluye respaldos gestionados, pero **nunca se ha verificado
ni probado una restauración** en este proyecto. Checklist único (≈30 min):

1. En Railway → servicio Postgres → pestaña **Backups**: confirmar que los
   respaldos automáticos están activos, su frecuencia y retención. Anotar aquí:
   - Frecuencia: `[COMPLETAR]`
   - Retención: `[COMPLETAR]`
   - Fecha de la prueba de restauración: `[COMPLETAR]`
2. **Prueba de restauración** (sin tocar producción): crear un servicio
   Postgres temporal, restaurar ahí el respaldo más reciente, apuntar un
   entorno local con `DATABASE_URL` al restaurado y verificar:
   `npx prisma db pull` no truena, `SELECT count(*) FROM "Invoice";` da un
   número plausible, y una empresa conocida abre su dashboard.
3. **Respaldo lógico adicional** (defensa en profundidad, opcional pero
   recomendado mientras no haya migraciones): un `pg_dump` semanal fuera de
   Railway (GitHub Actions con `pg_dump | gzip` a un bucket S3/R2 cifrado).
   Ojo: el dump contiene credenciales cifradas — el bucket debe ser privado y
   la llave `CREDENTIALS_ENCRYPTION_KEY` NUNCA se respalda junto al dump.

## 2. Esquema: `prisma migrate` (adoptado 2026-07-04)

El deploy ejecuta `node scripts/deploy-db.mjs`, que decide solo:

- **Base existente sin historial** (producción el día del cambio): baseline
  automático — `migrate resolve --applied 0_init` marca la migración inicial
  como aplicada SIN tocar el esquema, y luego `migrate deploy`.
- **Base con historial**: `migrate deploy` aplica lo pendiente.
- **Base vacía** (staging/entorno nuevo): `migrate deploy` corre `0_init`
  completo y crea todo el esquema.

Cualquier fallo aborta el deploy (la imagen anterior sigue sirviendo).
`--accept-data-loss` desapareció del pipeline.

Reglas nuevas:

- **Todo cambio de `prisma/schema.prisma` debe venir con su migración**:
  `npx prisma migrate dev --name <cambio>` en local (necesita un Postgres de
  desarrollo) y el SQL generado se revisa en el PR como cualquier código.
- Los renames/retypes ahora son posibles vía SQL revisado, pero siguen
  mereciendo el patrón de dos fases para cambios grandes con datos.
- Nunca editar a mano una migración ya aplicada en producción; corregir con
  una migración nueva.
- `0_init` es el baseline congelado del esquema al 2026-07-04; no se toca.

## 3. Variables de entorno críticas

Validadas al arranque por `src/lib/env-check.ts` (producción):

| Variable | Falta ⇒ | Nota |
|---|---|---|
| `CREDENTIALS_ENCRYPTION_KEY` | **no arranca** | 32 bytes base64; si se pierde, los secretos cifrados son irrecuperables — guárdala en un gestor de secretos aparte de Railway |
| `AUTH_SECRET` / `NEXTAUTH_SECRET` | **no arranca** | basta una; mantener ambas iguales |
| `CRON_SECRET` | advertencia | los crons responden 401 y ninguna tarea corre |
| `SENTRY_DSN` | advertencia | sin monitoreo de errores del servidor |
| `NEXT_PUBLIC_SENTRY_DSN` | advertencia (si `SENTRY_DSN` sí está) | sin monitoreo del **navegador**: un React roto se ve como silencio |

Rotación de la llave de cifrado: `npm run rotate:key` (ver script; requiere
la llave vieja y la nueva).

## 4. Señales de que algo anda mal

- **Sentry** (cuando las DSN estén configuradas): errores no manejados del
  servidor, del middleware edge y del navegador llegan solos. Las trazas
  cruzan hacia los satélites, así que un error del SPA Automotriz y la
  excepción del hub que lo causó aparecen como un solo hilo. Montaje completo,
  variables y el ciclo de PRs automáticos: **[docs/SENTRY.md](./SENTRY.md)**.
- **Crons**: corren desde GitHub Actions (`.github/workflows/*.yml`) contra
  producción; un run rojo en Actions = fallo de transporte. Los fallos
  lógicos por-empresa se ven en los logs de Railway y, para FIEL vencida,
  como notificación al usuario (`fiel-invalida:*`).
- **SAT sync detenido**: la insignia de vigencia en /empresa y la fecha de
  última sincronización; `GET /api/sat/sync/requests` lista las solicitudes
  con estado y error por empresa.
