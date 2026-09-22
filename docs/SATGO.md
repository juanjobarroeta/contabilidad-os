# SatGo: sustituir a Syntage en cumplimiento y declaraciones

Estado al 22-sep-2026. Objetivo: que en octubre el cumplimiento (opinión 32-D,
CSF, opinión IMSS) y los acuses de declaraciones mensuales vengan de SatGo con
la e.firma que ya guardamos, y Syntage se apague para eso.

## Qué cubre SatGo y qué no

| Dato | Hoy (Syntage) | Con SatGo | Notas |
|---|---|---|---|
| Opinión 32-D | `tax_compliance` (JSON + PDF) | `POST /api/v2/consultar/ocfiel` → PDF | Se lee con `satgo/sat-opinion.ts` (patrones, sin modelo). |
| CSF | `tax_status` (JSON + PDF) | `POST csffiel` → PDF | Estatus/CP por texto; regímenes con clave y obligaciones vía Claude (`parseSatDocument`). |
| Opinión IMSS | no la da | `GET imssoc` (sólo RFC) → PDF | Ya en producción (`/api/nomina/imss-opinion`). |
| Declaraciones mensuales | `tax-returns` + acuse PDF | `POST decfiel?ejercicio&mes&tipoDocumento` → ZIP `Declaraciones_<año>_<RFC>.zip` con `Normal_<año>_<Mes>.pdf` | `tipoDocumento=declaracion` = formulario completo (lo que parsea Claude: IVA causado/acreditable, ingresos, coeficiente; 3 s). `acuse` falló con 500 del SAT el 22-sep; `pago` (34 s) sólo trae importes a pagar y línea de captura. Orden: declaracion → acuse → pago. `satgo/declaraciones.ts`. |
| Declaración anual | `tax-returns` (Anual) + transcript | `decfiel` (¿mes=0 incluye la anual?) | **Pendiente de probar**: qué devuelve para la anual y si trae el transcript largo (coeficiente, pérdidas). |
| CFDI | descarga masiva propia (`sat-sync`) + censo Syntage (`CfdiFaltante`) | descarga masiva propia; `facfiel` sólo como censo | No cambia. |
| Contabilidad electrónica (balanzas/catálogo) | `electronic_accounting` (bootstrap + serie) | **SatGo no la tiene** | Pasa a la CE propia (`sat-native`, `ce-worker`). Es el único bloque que Syntage sigue cubriendo. |

SatGo cobra por RFC/mes (~$10 MXN) sin importar cuántas consultas; Syntage por
entidad/mes (~$170–300 MXN). Claude cuesta por PDF parseado (CSF ~1/mes/empresa,
acuses 1–2/mes/empresa); `parseSatDocument` ya lo registra en `CostEvent`.

## Piezas que ya existen (este PR)

- `ComplianceSnapshot.acusePdf` / `acusePdfNombre`: el PDF vive en la base, como
  `TaxDeclaration.acusePdf`. `persistComplianceResult` lo guarda; si el contenido
  no cambió pero el snapshot vigente no tenía PDF, se lo adjunta (gap-fill).
  `asegurarAcusePdf` convierte lo legado (data URL del IMSS, referencia a Syntage).
- `SatGoClient`: `consultarOcFiel`, `consultarCsfFiel`, `consultarDecFiel`, `consultarImssOc`.
- `SatGoComplianceProvider`: implementa `ComplianceProvider` completo (32-D, CSF, IMSS).
- `importarDeclaracionesSatGo(companyId, {ejercicio, mes})`: gap-fill de filas y
  PDF; sin costo si no falta nada; marcadores si el parseo pagado no se pudo leer.
- `scripts/satgo-corrida.ts`: la corrida manual (lo que hará el cron), con
  `--guardar DIR` para conservar los PDFs y revisar los parsers.
- `scripts/cumplimiento-acuse-a-bytes.ts`: pasa a bytes los acuses viejos.

## Workflow automático propuesto

Todo cuelga de `cron-scheduler.ts` como los demás jobs; cada job se auto-gatea
por empresa para no repetir consultas ni pagar parseos de más.

1. **`satgo-cumplimiento`** (tick cada 6 h, `MIN_CARO`). Por empresa elegible:
   - 32-D: pedir si no hay snapshot o el vigente tiene más de 30 días (vigencia
     de la opinión, regla 2.1.37 RMF). Negativa → hallazgo (ya lo hace `diff.ts`).
   - CSF: pedir si no hay snapshot o tiene más de 30 días. Una CSF nueva que
     cambie obligaciones actualiza `CompanyObligation` (`fuente = "CSF"`), como en
     el onboarding.
   - IMSS: pedir si el vigente tiene más de 30 días (hoy es manual desde Nómina).
   Empresa elegible = e.firma completa + `planIncluyeSyntage(tier)` + pago vigente
   (`nivelPagoEmpresas`), exactamente el criterio del aprovisionamiento actual.
2. **`satgo-declaraciones`** (tick cada hora, `MIN_CARO`, tope de 10 acuses por
   corrida). Por empresa elegible:
   - Del día 18 en adelante: pedir el mes anterior si le faltan filas o PDF; si
     el SAT dice «sin declaraciones», reintentar al día siguiente hasta fin de mes
     (la fecha límite es el 17, pero hay prórrogas y complementarias).
   - Gap-fill histórico: un periodo faltante por empresa y corrida, hacia atrás
     hasta `fechaInicioOperaciones` o 5 años. Sustituye a `declaraciones-backfill`.
   - Anual: en abril–mayo pedir `decfiel` del ejercicio cerrado y, si trae el
     transcript, correr `enriquecerAnualDesdePdf` (coeficiente y pérdidas).
3. **Alta del RFC en SatGo** al subir la e.firma (`UsersRFC add`), si la API lo
   exige para cobrar/permitir el RFC — **verificar** con la corrida de agosto: si
   los RFC no dados de alta responden igual, no hace falta paso de provisión.
4. **Baja**: al cancelar una empresa, `UsersRFC delete` (equivalente a
   `liberarSlotSyntage`).

## Corte (octubre)

- [ ] Correr `satgo-corrida --ejercicio 2026 --mes 8` para las 14 empresas
      Syntage (este PR) y revisar los PDFs guardados: que `sentidoSat` acierte el
      sentido en todos, que la CSF dé los mismos regímenes que Syntage, que los
      importes de agosto coincidan donde ya había fila (BAOBAB, Minerva, Reyes
      Huerta, ZIONX tenían agosto de Syntage).
- [ ] Probar `decfiel` para la anual 2025 en una PM (¿transcript o acuse corto?).
- [ ] Añadir `satgo-cumplimiento` y `satgo-declaraciones` al scheduler y dejarlos
      correr en paralelo con Syntage dos semanas: `persistComplianceResult` deduplica
      por hash, así que no duplica snapshots ni hallazgos.
- [ ] Añadir categoría `SATGO` en `costos/record.ts` (cargo por RFC/mes) para que
      Rentabilidad lo vea.
- [ ] Apagar `compliance-provision`, `compliance-sync` y `declaraciones-backfill`
      de Syntage; correr `cumplimiento-acuse-a-bytes` una última vez con
      `SYNTAGE_API_KEY` viva para bajar los acuses que falten; liberar slots.
- [ ] CE: mientras la CE propia no cubra bootstrap + serie de balanzas, dejar a
      Syntage SÓLO para `electronic_accounting` en las empresas que lo usan, o
      congelar la serie (ya importada) y cerrar Syntage del todo.
- [ ] `cumplimiento/page` y `OpinionImssCard`: sin cambio (leen `tieneAcuse` y
      `/api/cumplimiento/acuse/[id]`, que ya sirve los bytes).

## Riesgos conocidos

- Tiempos vistos en vivo (BARTIZ, 22-sep): 32-D 19 s, CSF 10 s, decfiel
  «declaracion» 3 s, «pago» 34 s; IMSS 75–90 s. El script corre 2 empresas en
  paralelo; el cron debe hacer pocas por tick y no bloquear el resto.
- La línea de captura NO viene en el documento «declaracion»; está en «pago».
  Si hace falta para conciliar el pago (SIPARE/banco), pedir también «pago» y
  fusionar `lineaCaptura` (segunda llamada + segundo parseo).
- `SATGO_API_KEY` debe ser la llave durable (`POST /Users/CreateKey`), no la
  sesión de Clerk; el cliente avisa si el token venció.
- El lector del 32-D es heurístico y se escribió sin PDF a la mano: los PDFs de
  la corrida de agosto son la prueba real. Si un sentido sale `ERROR`, el PDF
  queda guardado y el snapshot lo dice.
- La CSF vía Claude escribe las obligaciones sin el punto final que Syntage
  conserva («…de IVA.» vs «…de IVA»): la corrida del 22-sep abrió 11 hallazgos
  «cambiaron tus obligaciones» falsos. `diff.ts` compara ya por clave
  normalizada (`claveObligacion`); el primer sync tras ese cambio abre un
  snapshot nuevo por empresa (cambia el hash) sin hallazgos.
- `decfiel` con normal + complementaria del mismo mes: la Normal crea las filas y
  la Complementaria sólo adjunta PDF si faltaba. Sustituir importes por la
  complementaria queda para después (hoy tampoco lo hace Syntage).
