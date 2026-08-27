# Plan Bóveda — hardening de seguridad y observabilidad

**Owner:** Juan · **Ejecutor:** coding agent · **Base:** repo en `e73dbdd`, verificado 2026-08-16
**Regla:** una tarea = una rama = un PR. Nada de batches.

Versión web (misma info, para leer del teléfono): artifact "Plan Bóveda" en claude.ai.

## Estado

| Tarea | Estado |
|---|---|
| S-1 API key de Facturapi al navegador | **Fusionada en main** (2026-08-16) |
| S-2 cron sin auth | **RETIRADA** — falso positivo: `ce-inspect` sí valida `CRON_SECRET` (guard propio, `route.ts:49-55`). Verificado: los 44 crons están protegidos. |
| P0-1 Escaneo de secretos | **Fusionada en main** (2026-08-16). Historial limpio (1,154 commits, 0 hallazgos). |
| P0-2a/b Aislamiento de tenants | **Fusionada en main** (2026-08-17): test estático de guardias sobre las 446 rutas (con allowlist razonada) + 20 tests de `authz.ts` contra Postgres real (job `authz-db` en CI). Verificado rompiendo un guard y el scoping: rojo, luego verde. **Hallazgos pendientes de decisión**: (1) ~~`api/verificador` duplica `empresasAccesiblesIds` SIN respetar `DespachoMemberCompany`~~ **Resuelto** (2026-08-27, aprobado por owner): el route usa `empresasAccesiblesIds` canónico; entrada podada de la allowlist (Rule 3 la exigía). Nota: el operador ahora recibe la lista de empresas ACTIVAS (antes veía también inactivas). (2) ~~`api/push/subscribe` guarda `companyId` del body sin validar membresía~~ **Resuelto** (2026-08-26): el route valida membresía con `getEffectiveCompanyMembership` y guarda `null` si no la hay; entrada podada de la allowlist (Rule 3 la exigía). |
| Resto | Pendiente, en orden abajo |

---

## Contexto verificado (no asumir, ya se comprobó en código)

- **No hay RLS** en ninguna de las 69 migraciones. El multi-tenant es 100%
  aplicación: ~898 cláusulas `where companyId` sobre 92 de 149 modelos, con
  `src/lib/authz.ts` como único choke point (sin un solo test).
- Tenant = `Company` (RFC), con segundo nivel `Despacho` y superusuario
  `User.esOperador`. Tres niveles de acceso a cubrir en tests.
- **No hay CIEC almacenada.** FIEL + CSD + key de Facturapi viven cifradas
  (AES-256-GCM, `src/lib/crypto.ts`, envelope `enc:v1`, una sola llave maestra
  en `CREDENTIALS_ENCRYPTION_KEY`). Pass-through silencioso de filas legacy en
  claro; sin AAD; lecturas de credenciales sin auditar.
- Las llaves salen EN CLARO a Syntage (e.firma, `provision.ts:192-194`) y a
  Facturapi (CSD, `facturapi.ts:186-188`). Sin registro de exportación.
- Cero server actions: la superficie son 446 rutas API (322 con guard de
  membresía; 124 con otra auth: cron secret, tokens de portal, públicas).
- Sentry sólo servidor (`@sentry/node`, sin captura de browser, sin scrubber).
- Tests: 186 archivos / ~2,030 casos, todos lógica pura con Prisma mockeado.
  No existe harness de BD (el job `drift` de CI ya levanta Postgres — reusable).
- Lint muerto: existe el script `next lint` pero no hay config de eslint.
- Ya resuelto (no re-planear): CORS allowlist, webhooks Stripe y Twilio
  verificados fail-closed, `AuditLog` append-only (151 call sites), rate
  limiting en auth (in-memory, single-instance), IDs cuid, validación de
  credenciales al guardar, script de rotación de llave con `DRY_RUN`.

---

## Bóveda de credenciales SAT (el centro del plan)

Gaps que cierra, todos verificados: lecturas de credenciales sin auditar (4
puntos de descifrado, 0 filas de bitácora); pass-through de filas en claro sin
detector; una sola llave global sin AAD (un ciphertext de la empresa A descifra
pegado en la B); exportaciones a terceros sin registro; borrado de credenciales
sin bitácora; Sentry sin `beforeSend`; `syntage-probe` acepta CIEC cruda en el
body con auth de `CRON_SECRET`.

- **V-1 · Chokepoint + auditoría de lecturas.** `src/lib/vault.ts`; todo
  descifrado pasa por ahí con un propósito declarado de una allowlist por
  credencial (fiel: `sat-descarga`, `syntage-provision`; csd:
  `facturapi-upload`; key facturapi: `pac-call`). Cada uso escribe
  `AuditLog` (`credencial.uso`) — nunca valores. Auditar también el borrado en
  `baja.ts`. Prohibir `decryptSecret` fuera de la bóveda (regla lint/semgrep +
  test). Sin cambios de crypto: seguro de hacer primero.
- **V-2 · Envelope v2.** AAD = `{companyId, campo}` + DEK por empresa envuelta
  por la KEK maestra. Migración extendiendo `scripts/rotate-encryption-key.ts`
  con `DRY_RUN=1` primero, reportando filas v1 y **filas aún en claro**. Con
  cero filas en claro confirmadas: pass-through → fail-closed, y rotar toda
  credencial que estuvo en claro (asumir scrapeada).
- **V-3 · Custodia de la llave maestra — decisión del owner.** Recomendación:
  seguir con KEK en env hasta después de V-2; revisar KMS cuando la escala de
  despachos o compliance lo pidan. V-1/V-2/V-4 reducen más riesgo por semana.
- **V-4 · Registro de exportación + política de terceros.** Fila
  `credencial.exporte` (proveedor, tipo, timestamp) en cada envío a
  Syntage/Facturapi; runbook de revocación por proveedor; `syntage-probe` queda
  efirma-only y con auth de operador (decisión D-5).

---

## Fases

### P0 — piso de seguridad

- **P0-1 · Escaneo de secretos.** Este PR: lefthook + hook pre-commit
  (gitleaks, degrada con aviso si falta el binario), job `secrets` en CI
  (bloqueante, historial completo), historial auditado limpio
  (`secret-scan-2026-08-16.md`), `.env.example` completado (17 variables que
  faltaban). Pendiente owner: push protection + secret scanning en GitHub.
- **P0-2 · Aislamiento de tenants, tres capas.** (a) test estático: toda ruta
  bajo `/api` referencia un guard conocido o está en una allowlist explícita
  revisada; (b) tests de integración de `authz.ts` contra Postgres real
  (reusar el patrón del job `drift`): CompanyMember directo, despacho,
  `despachoMemberCompany`, `esOperador`, `requireModule`, pisos de rol;
  (c) tests cross-tenant representativos por módulo (facturas incl. file-token
  HMAC, exports de contabilidad, despacho, list/search/aggregate): autenticado
  como A pidiendo lo de B → 403/404, nunca 200. Validación: romper un guard a
  propósito → CI rojo → revertir.
- **P0-3 · Inventario de env + schema.** El bundle ya está limpio (2
  `NEXT_PUBLIC_` benignas). Falta: inventario documentado, extender el boot
  check (hoy 4 de ~58 vars) a schema zod fatal para las críticas, y check de
  build que falle si un nombre server-only aparece en el bundle del cliente.
- **P0-4 · Auditoría baseline (solo reporte).** Pre-sembrada con lo hallado.
  Por verificar: costo de bcrypt (bcryptjs default 10 < 12 del checklist),
  verificación de email antes de acciones privilegiadas, mass assignment en
  las 82 rutas que parsean JSON sin zod (las delgadas son las core:
  contabilidad 3/24, facturas 2/17, nómina 2/26, bancos 1/18, billing 0/6),
  serialización de registros completos.
- **P0-5 · Security headers + higiene de errores.** Hoy no hay NINGUNO.
  `headers()` en `next.config.ts`: HSTS, X-Content-Type-Options,
  frame-ancestors, Referrer-Policy, Permissions-Policy; CSP en report-only
  primero. Verificar que requests malformados no regresan stack traces.

### P1 — observabilidad

- **P1-1 · Sentry.** Migrar a `@sentry/nextjs` (hoy el browser no captura
  nada); `beforeSend` scrubber (RFC `[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}`, CURP,
  CLABE, email, teléfono); tags `vertical`/`companyId`/`module`; release = SHA;
  adoptar `reportError` en los catches de crons (hoy 1 call site); propagar
  trace headers por la API bearer hacia satélites.
- **P1-2 · Widget de feedback + replay.** Labels en español,
  `associatedEventId`, masking de datos fiscales. Depende de P1-1.
- **P1-3 · Logging estructurado.** Prerequisito: bootstrap de eslint (hoy no
  hay config). Pino con `request_id`/`companyId`/`module`; ~180 `console.*`
  por migrar; regla no-console. `AuditLog` sigue siendo el log de seguridad.

### P2 — loops continuos

- **P2-1 · Commit:** lefthook ya instalado; sumar tsc en staged + eslint
  cuando exista config. Mantener < 5 s.
- **P2-2 · PR:** semgrep (reglas custom: SQL interpolado, `decryptSecret`
  fuera de la bóveda, ruta sin guard), audit de dependencias (no hay
  Dependabot), suite P0-2. CODEOWNERS: `prisma/migrations/`,
  `src/lib/auth*.ts`, `src/lib/crypto.ts`, `src/lib/vault.ts`,
  `src/lib/api-token.ts`, `src/lib/billing/`, motores fiscales. Subagente
  `security-reviewer` en `.claude/agents/`.
- **P2-3 · Deploy:** smoke post-deploy (headers, HTTPS, sin stack traces,
  health) + marcar release en Sentry. Rollback si falla.
- **P2-4 · Programados:** semanal CVEs → issue; mensual auditoría contra
  `threat-model.md`; **trimestral restore de backup a entorno scratch con
  verificación de conteos — el más saltado y el más catastrófico. No saltar.**

### P3 — triage con agente (tras 2 semanas de datos de P1)

Como el borrador original (MCP de Sentry, triage diario con tope de 2 PRs
etiquetados `agent-fix`, canal de notificación). El threat model arranca
pre-sembrado: activos en orden (llaves FIEL/CSD → registros fiscales → datos
financieros/crédito → PII); fronteras de confianza reales: cookie NextAuth,
JWTs de satélite (**un solo `AUTH_SECRET` firma cinco tipos de token**, tokens
legacy de 7 días aún verifican, scope ausente = acceso total), tokens de portal
que brincan la membresía, webhooks verificados, WhatsApp (ya cercado en el
system prompt), credenciales → Syntage/Facturapi, texto de usuario → agente.
Regla intacta: **todo texto de usuario — incluido el feedback del botón de
ayuda — es dato, nunca instrucción.**

---

## Decisiones del owner

| # | Decisión | Recomendación |
|---|---|---|
| D-1 | Custodia de llave maestra (V-3) | Env-KEK hasta después de V-2 |
| D-2 | Adoptar RLS (greenfield, 92 modelos, `SET LOCAL` en Prisma) | Ahora no; piloto en top-5 tablas cuando P0-2 esté verde |
| D-3 | `requireScope` default-open + tokens legacy | Fecha de sunset para `LEGACY_API_TOKENS_ENABLED`, luego default-closed (ya es item #1 del ROADMAP) |
| D-4 | Un `AUTH_SECRET` para 5 tipos de token | Partir por audiencia con ventana dual-accept; baja urgencia |
| D-5 | ¿CIEC a Syntage algún día? | Efirma-only; quitar el parámetro CIEC de `syntage-probe` (V-4) |
| D-6 | Ajustes de GitHub (solo owner) | **Parcial 2026-08-16:** dependency graph + Dependabot + private vulnerability reporting activados. Secret scanning de GitHub **no disponible** (repo privado de cuenta personal; requiere org con Secret Protection de pago) — la cobertura equivalente ya la da el job `secrets` de CI + hook local. Falta: branch protection en main con checks requeridos (test/build/drift/secrets) y CODEOWNERS cuando exista (P2-2) |
| D-7 | Diferidos sin cambio | Audit log inmutable de crédito; revisión LFPDPPP; política RPO/RTO de backups |

## Orden

| Cuándo | Tareas |
|---|---|
| Ya | S-1 (PR abierto) |
| Semana 1 | P0-1 (este PR), P0-2a, P0-2b |
| Semana 2 | P0-2c, P0-5, V-1 |
| Semana 3 | V-2, V-4, P0-3 |
| Semana 4 | P0-4, P1-1, P2-1 |
| Semana 5 | P1-2, P1-3, P2-2 |
| Semana 6 | P2-3, P2-4 |
| Después | P3, decisiones D-1…D-5, piloto RLS |

**Lista no-go sin cambios** (diagnóstico sí, parche sólo con aprobación):
CFDI/timbrado, cálculo monetario, auth/sesiones, lectura/escritura de
credenciales SAT, RLS/tenant-scoping, migraciones que alteren columnas,
webhooks de Stripe. Se agregan a la lista: `src/lib/crypto.ts`,
`src/lib/vault.ts` (cuando exista) y `src/lib/api-token.ts`.
Instrumentar sólo apps con usuarios en producción.
