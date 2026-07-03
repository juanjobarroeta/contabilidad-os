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

## 2. Esquema: `db push` hoy, `prisma migrate` como destino

Hoy `railway.json` ejecuta en cada deploy:

```
npx prisma db push --skip-generate --accept-data-loss
```

Esto funciona **solo** porque mantenemos la disciplina de cambios aditivos.
`--accept-data-loss` significa que un rename/drop/retype en `schema.prisma`
**tira la columna con sus datos, sin preguntar**, en el deploy.

Reglas vigentes mientras exista `db push`:

- Todo diff de `schema.prisma` se revisa en PR con la pregunta explícita:
  ¿es 100% aditivo? (columna opcional nueva, tabla nueva, índice nuevo).
- Prohibido: renombrar columnas/tablas (es drop+create), cambiar tipos,
  quitar columnas, volver requerido un campo existente sin default.
- Si un cambio no-aditivo es inevitable: hacerlo en dos fases (agregar lo
  nuevo → migrar datos con script → dejar de leer lo viejo → borrar lo viejo
  en un deploy posterior y con respaldo verificado ese mismo día).

**Destino** (cuando haya un hueco tranquilo): adoptar `prisma migrate`.
Camino estándar para una base existente (baseline):

1. `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/0_init/migration.sql`
2. `npx prisma migrate resolve --applied 0_init` contra producción.
3. Cambiar `preDeployCommand` a `npx prisma migrate deploy`.
4. A partir de ahí, cada cambio de esquema genera migración revisable en PR.

## 3. Variables de entorno críticas

Validadas al arranque por `src/lib/env-check.ts` (producción):

| Variable | Falta ⇒ | Nota |
|---|---|---|
| `CREDENTIALS_ENCRYPTION_KEY` | **no arranca** | 32 bytes base64; si se pierde, los secretos cifrados son irrecuperables — guárdala en un gestor de secretos aparte de Railway |
| `AUTH_SECRET` / `NEXTAUTH_SECRET` | **no arranca** | basta una; mantener ambas iguales |
| `CRON_SECRET` | advertencia | los crons responden 401 y ninguna tarea corre |
| `SENTRY_DSN` | advertencia | sin monitoreo de errores |

Rotación de la llave de cifrado: `npm run rotate:key` (ver script; requiere
la llave vieja y la nueva).

## 4. Señales de que algo anda mal

- **Sentry** (cuando `SENTRY_DSN` esté configurada): errores no manejados de
  rutas y render llegan solos vía `onRequestError`.
- **Crons**: corren desde GitHub Actions (`.github/workflows/*.yml`) contra
  producción; un run rojo en Actions = fallo de transporte. Los fallos
  lógicos por-empresa se ven en los logs de Railway y, para FIEL vencida,
  como notificación al usuario (`fiel-invalida:*`).
- **SAT sync detenido**: la insignia de vigencia en /empresa y la fecha de
  última sincronización; `GET /api/sat/sync/requests` lista las solicitudes
  con estado y error por empresa.
