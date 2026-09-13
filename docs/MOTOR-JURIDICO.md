# Motor jurídico — de la KB fiscal a todo el derecho mexicano (leyes + jurisprudencia), con dos productos encima

> Status: **F0 hecha y medida (2026-09-11, PR #994).** F1–F3 siguen siendo
> propuesta.
>
> **F0 — resultado.** Catálogo federal completo generado desde Diputados
> (`catalogo/federal.json`, 317 ordenamientos, 6 excluidos con motivo),
> materias/ámbito/entidad en el esquema, filtro `MATERIAS_CONTADOR` fijo en el
> executor del hub (52 leyes federales visibles al contador), ingesta por lotes
> y refresco semanal en loop. Carga inicial en producción: 300 leyes nuevas,
> 40 453 chunks, 23 minutos, 1 fallo (CFCDMX: su sitio no respondió; el
> refresco semanal reintenta). Eval sólo-KB (96 preguntas, recuperación
> top-6): **65/96 antes → 69/96 después** (67.7 % → 71.9 %), cuatro preguntas
> ganadas (c07, j30, j33, n02) y ninguna perdida: el criterio de salida se
> cumple. Pendientes menores: tres leyes minúsculas con artículos en ordinal
> («ARTICULO PRIMERO.-»: LCNP, LISEDIP, LRART73-XVIII) quedaron como un solo
> chunk porque el chunker sólo reconoce números; y los resúmenes por unidad
> para las leyes nuevas (workflow «Fiscal KB resúmenes», ~60–100 USD una vez)
> no se han corrido: decisión del owner.
>
> **F1 — corpus cargado (2026-09-11, PRs #1002, #1005, #1014).** Código en
> `src/lib/fiscal-kb/sjf/` (normalizador puro y probado, cliente Playwright al
> API de datos abiertos, ingesta por lotes con `SjfTesisVista` como memoria) y
> `scripts/sjf-worker.ts`; servicio Railway `sjf-worker` (misma imagen que el
> worker de CE; cron semanal sábados 06:30 CT en modo «nuevas»; se redespliega
> sólo si cambian sus propios archivos). Esquema: `FiscalDocument` gana
> registro, numeroTesis, epoca, instancia, organo, tipoCriterio,
> estadoCriterio y fechaPublicacion; `vigenciaDesde` de una tesis es la fecha
> desde la que obliga. Herramientas `search_jurisprudencia` y `get_tesis`; el
> hub las ve con materias del contador + administrativa (en el SJF lo fiscal
> vive en «Administrativa»); `search_fiscal_knowledge` es normativa (sin
> tesis) salvo que el modelo pida TESIS. Incapsula: el headless clásico
> recibe 403 siempre; el headless nuevo (`channel: "chromium"`) con la
> automatización oculta pasa el reto en la primera carga, también desde
> Railway.
>
> **Carga inicial (9a.–12a. Época):** los 311 965 ids del API recorridos en
> tres corridas (dos redeploys a media carga; el modo «faltantes» reanudó sin
> repetir), 0 fallidas, ~50 s por página de 1 000 cuando hay que embeber y
> ~30 s cuando sólo se registra. Resultado: **≈ 92 500 tesis embebidas** (10a.–
> 12a. ≈ 37 000; 9a. 55 470) y 219 395 tesis de la 3a. a la 8a. registradas en
> `SjfTesisVista` sin embeber (5a. 121 787, 8a. 36 743, 7a. 32 414, 6a. 27 432,
> 3a. 893, 4a. 126). Tamaño: ≈ 0.6 GB de vectores + índice — **se queda en la
> misma Postgres**, sin `halfvec` (decisión §3.2 tomada).
>
> **Eval del contador tras F1** (sólo-KB, 96 preguntas, medido como busca el
> hub: normativa + materias del contador): **66/96 (68.8 %)**, contra 65/96
> (67.7 %) antes de F0. Las mediciones de la tarde (69/96) eran sin filtro de
> materias, así que no comparan. Sin regresión.
>
> **Satélite con URL propia (2026-09-11):** repo privado
> `juanjobarroeta/copiloto-juridico` (Next 15; sin base ni auth: bearer del
> hub vía `POST /api/auth/token` + refresh, chat SSE contra
> `/api/juridico/chat`, conversaciones contra `/api/juridico/conversaciones`),
> proyecto Railway `copiloto-juridico`, URL
> https://copiloto-juridico-production.up.railway.app, variable
> `NEXT_PUBLIC_HUB_URL`. En el hub: `/api/juridico/*` resuelve sesión o
> bearer (`requireUser`), el middleware de CORS lo cubre y
> `API_ALLOWED_ORIGINS` incluye el origen del satélite. Nombre y marca
> pendientes (renombrable). Sigue siendo sólo operador hasta que exista el
> módulo `JURIDICO` y su plan.
>
> **Superficie de prueba (2026-09-11):** `/operador/juridico` — el perfil
> abogado (`src/lib/ai/system-prompt-abogado.ts`, `tools-abogado.ts`,
> `executor-abogado.ts`) sobre todo el corpus + jurisprudencia, sin empresa,
> con verificación de citas siempre encendida, conversaciones guardadas
> (`JuridicoConversacion` / `JuridicoMensaje`) y la traza de cada respuesta a
> la vista (herramientas, fundamentos devueltos, verificación) más pulgar
> arriba/abajo. Sólo operador; el gasto se registra al usuario (subtipo
> `ai.juridico`). Es el embrión del chat del producto legal (§6).
>
> **F3 (primer paquete) — construcción y urbanismo en los tres niveles
> (2026-09-11, PR #1028).** El catálogo pasó de 317 a **1 229 ordenamientos**:
> 311 leyes federales, 138 reglamentos federales (Diputados `regla.htm`,
> `catalogo/reglamentos-federales.json`), 124 NOM de construcción e
> instalaciones (de las 1 228 vigentes que cataloga PLATIICA en
> `catalogo/nom.json`; `KB_NOM_TODAS=1` mete todas), y **493 estatales +
> 164 municipales de las 32 entidades y 62 municipios**: lo que rastrea el
> Orden Jurídico Nacional (`scripts/fiscal-catalogo-ojn.ts` → `catalogo/ojn.json`,
> 32 estados × 4 poderes + capital y municipios principales, filtrado a
> ley/código/reglamento de construcción, obra pública, desarrollo urbano,
> protección civil, catastro, fraccionamientos, condominios e imagen urbana)
> más un catálogo **curado a mano** (`catalogo/estatales.src.json` →
> `estatales.json`) para lo que el OJN no tiene: Morelos, Nuevo León, Sonora y
> Guanajuato sólo publican acuerdos ahí, y Puebla, Estado de México, Guerrero,
> Querétaro, San Luis Potosí y Tlaxcala no traen los códigos de construcción
> municipales (COREMUN de Puebla, Código Territorial de Guanajuato, Libro Quinto
> del Código Administrativo mexiquense, Monterrey, León, Toluca…). Cada URL
> curada se verificó con `curl` (200 + PDF/Word real) y una entrada puede
> `reemplaza`r la del OJN cuando abrogó a la ley que el OJN sigue listando.
> CDMX entra a mano: Reglamento de Construcciones (Consejería) y las Normas
> Técnicas Complementarias 2023 (Gaceta, como «guía» por secciones).
>
> Lo que hizo falta tocar: el OJN publica la mitad en Word y la extensión
> miente (muchos «.doc» son OOXML), así que `texto.ts` detecta el formato por
> bytes mágicos — PDF, .docx (mammoth), .doc de Word 97 (antiword) y RTF
> (unrtf), los dos últimos sólo en la imagen del worker
> (`Dockerfile.ce-worker`). Ingesta por lotes en un servicio Railway propio,
> `kb-worker` (`npm run kb:worker`, modo `faltantes`), en vez del workflow de
> GitHub. Materias nuevas `construccion` y `urbano`, `municipio` en
> `FiscalDocument`, `FiscalSource.NOM`. Huecos conocidos: municipios sin
> reglamento propio localizable (San Pedro Garza García, Apodaca, Ecatepec,
> Huixquilucan, Cuautlancingo, Tlaxcala capital, Apizaco, San Juan del Río
> con portal roto); Ley 790 de Guerrero sin texto consolidado posterior a 2018
> (dos decretos de reforma sueltos en el P.O.); y los municipios más allá de
> los principales (`--municipios todos` los rastrea, no se ha corrido).
>
> **F2 (primer trozo) — leer y analizar documentos (2026-09-12, PR #PRNUM2).**
> El satélite y `/api/juridico/documentos` aceptan PDF, DOCX y TXT (clip o
> arrastrar al chat): se extrae el texto (pdf-parse / mammoth; .doc y escaneos
> se rechazan con mensaje), se indexa por secciones (cláusulas, artículos,
> apartados con offsets) y se guarda el texto, no el archivo, en
> `JuridicoDocumento` (borrado real con DELETE). En el turno, el índice va en un
> bloque propio del system prompt — y el texto entero si la conversación suma
> ≤ 90 000 caracteres — y el agente recorre el documento con `leer_documento`
> (índice / sección / rango) y `buscar_en_documento` (pasajes por términos);
> el prompt le exige separar lo que el documento DICE, lo que la LEY dice
> (fundamentado con el corpus) y su LECTURA. **Fotos y escaneos** (PR #1037):
> JPEG/PNG/WebP y los PDF sin capa de texto se transcriben con visión
> (`vision.ts`, Sonnet 5 por lotes de 4 páginas en paralelo — un PDF se parte
> con pdf-lib —, «— Página N —», `[ilegible]`/`[firma]`, costo en
> `ai.juridico.ocr`); varias fotos en una subida son UN documento; el satélite
> reduce las fotos del teléfono a 2 000 px antes de mandarlas; HEIC se rechaza
> con instrucción. Y el turno del abogado, si agota sus 10 rondas de
> herramientas, cierra con una vuelta sin herramientas (antes se quedaba en
> «voy a fundamentar…»). **Redacción** (PR #PRNUM4): `redactar_documento`
> guarda lo que el copiloto escribe (contrato, convenio, demanda, escrito)
> como documento de la conversación (mime `text/markdown`; el mismo
> `documento_id` para sustituir un borrador tras pedir cambios) y
> `GET /api/juridico/documentos/[id]/docx` lo entrega en Word (`docx`:
> Times 12 justificado, apartados centrados, folio al pie); el satélite lo
> muestra como chip «borrador» con vista previa y descarga, y avisa por SSE
> (`documento`) en cuanto se guarda. El prompt exige recuperar las normas del
> tipo de documento antes de escribir, [___] para lo que no se sabe, y
> presentarlo como borrador para revisión del abogado. Acceso: el operador o
> `User.accesoJuridico` (PR #1039, `scripts/crear-usuario-juridico.ts`).
> **Contestar demandas** (PR #1041): el prompt del abogado trae el flujo
> completo — leer la demanda entera, recuperar la vía y sus plazos (CNPCF /
> local / CCOM / LFT / CFF), contestar hecho por hecho, proponer excepciones
> procesales y de fondo con fundamento, criterio, prueba y fuerza (y cuáles
> NO oponer), entregar la estrategia en el chat y el escrito de contestación
> completo con `redactar_documento` (tipo `contestacion`). **PWA** (satélite):
> manifest, iconos, service worker sin caché de datos (sólo página «sin
> conexión»), botón «Instalar app» (prompt nativo en Android/Chrome; pasos
> Compartir → Añadir a inicio en iPhone), cajón lateral y safe areas en
> teléfono.
>
> **Códigos estatales de los 32 estados (PR #1044, 2026-09-13).** La abogada
> preguntó por el juicio oral familiar de Chihuahua y el copiloto, con razón,
> dijo que no tenía el Código de Procedimientos Familiares: sólo había
> construcción. Ahora el catálogo curado (`estatales.src.json`, 440 entradas)
> trae por entidad, desde el sitio del congreso local y verificado con `curl`:
> constitución, códigos civil, de procedimientos civiles, familiar y de
> procedimientos familiares (donde existen), penal, fiscal/financiero y
> administrativo; leyes orgánicas del poder judicial y del tribunal de justicia
> administrativa, de justicia alternativa/mediación, de justicia y procedimiento
> administrativo, de hacienda, del notariado y de responsabilidades. 377
> ordenamientos, 221 códigos estatales; el catálogo total pasa de 1 276 a
> **1 715** (932 estatales, 211 municipales). El OJN se rastreó también en modo
> `--codigos` (196) como respaldo, y `firmaEstatal()` deduplica por título
> normalizado dando preferencia a la copia del congreso. Huecos anotados por los
> agentes: Zacatecas servía 500 al verificar (URLs tomadas de la última captura
> oficial; revisar), NLE sin Ley de Procedimiento Administrativo (en dictamen),
> varios estados sin ley propia de responsabilidades (aplican la general).
> El prompt del abogado ya no dice «Puebla y CDMX» y le exige buscar el
> ordenamiento estatal por nombre antes de declararlo ausente.
> **Expedientes completos (PR #1045, 2026-09-13).** «She might be working
> full expediente: a lot of PDFs». Límites de expediente: 60 MB por archivo, 25
> documentos y 3 000 000 de caracteres por conversación; escaneos de hasta 400
> páginas (lotes de 4 en paralelo, 6 a la vez). Un documento de más de 40 000
> caracteres se **resume por secciones al subirlo** (`resumirDocumento`: lotes
> de ~14 000 caracteres a Haiku 4.5, 6 en paralelo, JSON `{n, resumen}` por
> sección + resumen general; guardado en `JuridicoDocumento.resumenes`, costo
> en `ai.juridico.resumen`). En el turno, si el texto no cabe en el prompt
> (> 90 000 caracteres) van los resúmenes por sección (hasta 70 000
> caracteres; pasado eso, sólo el general de cada documento) y el índice de
> `leer_documento` los trae también, así el agente va directo a la sección que
> importa. Con documentos, el turno tiene 24 rondas de herramientas (10 sin
> ellos) y `leer_documento` da 20 000 caracteres por lectura. El prompt le
> pide distinguir los documentos de un expediente (demanda, contestación,
> pruebas, acuerdos, sentencia) y no confundir lo que dice una parte con lo
> que resolvió el juez.
>
> **Turnos reanudables (PR #1042).** La primera prueba real de la abogada
> (alegatos de cinco tipos para un juicio oral familiar en Chihuahua, 8
> minutos) murió con «Load failed» en el iPhone. Dos causas, las dos
> corregidas: (1) `max_tokens` 6 144 cortaba a la mitad la llamada a
> `redactar_documento` con el escrito entero y la ronda siguiente moría con
> «user messages must have non-empty content» — ahora 16 000 tokens, el bloque
> abierto se cierra al terminar el stream, una llamada cortada se le dice al
> modelo en vez de ejecutarse con `{}`, y una ronda sin llamadas no manda un
> turno vacío; (2) el turno vivía en la conexión HTTP — ahora corre como tarea
> del proceso (`src/lib/juridico/turnos.ts`): guarda cada evento, el mensaje
> del usuario se persiste al arrancar y la respuesta (o lo que alcanzó, con
> `meta.error`) al terminar; la respuesta HTTP es una vista y
> `GET /api/juridico/chat?conversacionId=&desde=N` reengancha desde el último
> evento visto. El satélite reintenta con backoff hasta 15 min y, si el hub ya
> no tiene el turno en memoria (se redesplegó), recarga la conversación. Los
> errores del turno se reportan a Sentry (antes se tragaban).
> `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=300` en el hub: un redespliegue deja
> terminar los turnos en curso. Límites de Railway: 15 min por petición, 5 min
> sin datos (los pings cada 10 s lo cubren). Pendiente: plantillas del abogado,
> PDF de salida, cambio de contraseña en el satélite.
>
> **Carga inicial (2026-09-12, kb-worker):** dos corridas — la primera 731
> ingeridos / 179 fallidos por el catálogo (PR #1029: «00-00-0000» y
> mojibake del OJN), la segunda 207 / 41. En producción quedan **1 235
> ordenamientos vigentes** (federal: 311 leyes, 137 reglamentos, 111 NOM;
> estatal: 307 leyes, 170 reglamentos; municipal: 199), 32 entidades, 60
> municipios, ≈ 194 000 chunks. Los 41 que no entran: 18 PDF escaneados sin
> texto (reglamentos municipales viejos: Puerto Vallarta, Bahía de Banderas,
> Tulancingo…), 9 enlaces 404 de PLATIICA, 6 sitios que no responden
> (CFCDMX otra vez), 3 con 403 al User-Agent (Sonora; corregido: UA de
> navegador), 3 NOM sin fecha en la ficha (corregido: fecha del catálogo),
> 1 PDF corrupto y 1 texto con NUL (corregido). Los escaneados necesitarían
> OCR: decisión pendiente.
>
> **Pendiente de F1:** preguntas doradas de jurisprudencia con `tesisEsperadas`
> revisadas por el abogado y la métrica «tesis pertinente» en el eval; prueba
> funcional de `search_jurisprudencia` desde el chat; los resúmenes por unidad
> no aplican a tesis (el rubro ya lo es).
>
> Antecedente: `docs/FISCAL-KNOWLEDGE-BASE.md` (diseño original de la KB) y la
> serie de commits «Copiloto · Fase 1–3» / «KB: …» del 3–4 de septiembre de 2026.

---

## 1. Qué se decide con este documento

Hoy el copiloto de Contabilidad OS responde derecho **fiscal y su periferia** con
fundamento recuperado de una base de conocimiento propia. La idea es llevar el
mismo motor a **todo el orden jurídico mexicano** (federal y estatal) **más la
jurisprudencia**, y montarle dos productos:

1. **Contabilidad OS** (el de hoy): sigue contestando sólo lo que un contador
   necesita. Gana cobertura (leyes que hoy no están) pero **no** cambia de alcance.
2. **Un producto legal aparte** (frontend nuevo): contesta cualquier materia, lee
   contratos y demandas, ayuda a redactar contratos y escritos. Necesita leyes y
   jurisprudencia; el fiscal es un subconjunto.

Las cinco decisiones de diseño están en §3. El resto es inventario (§2),
fuentes verificadas (§4), cambios concretos por archivo (§5), el producto legal
(§6), fases con criterio de salida (§7) y lo que sólo Juan puede decidir (§8).

---

## 2. Punto de partida: lo que ya existe y cuánto rinde

Todo vive en `src/lib/fiscal-kb/` y `src/lib/ai/`. No es un prototipo: está en
producción, medido y con refresco automático.

| Pieza | Dónde | Estado |
|---|---|---|
| Ingesta de leyes desde PDF oficial (Diputados, OJP Puebla, Consejería CDMX) | `ingest-leyes.ts`, `pdf.ts` | 20 fuentes en catálogo (4 leyes fiscales, 3 reglamentos, 3 de nómina + 2 reglamentos IMSS/INFONAVIT, CCom, LGSM, LFPIORPI + reglamento, LFDC, 2 de Puebla, 1 de CDMX) |
| Chunker por unidad legal (artículo / regla / guía) con breadcrumbs, índice fuera, notas al pie corregidas | `chunk.ts` | Probado contra ocho editores distintos de PDF |
| Versionado por vigencia (una versión nueva CIERRA la anterior; búsqueda filtrada por fecha) | `upsert.ts`, `search.ts` | Vivo; la historia empieza en la primera ingesta |
| Embeddings | `embed.ts` | OpenAI `text-embedding-3-small`, 1536 dims, pgvector |
| Búsqueda: vector + rerank con Haiku (default); híbrido léxico existe pero medido peor y apagado; brazo exacto por número de artículo | `search.ts`, `fusion.ts`, `rerank.ts`, `diversificar.ts` | Recuperación top-6: 48 % sólo vector → **65 % con rerank** (eval sólo-KB, 80 preguntas) |
| Resúmenes por unidad («qué preguntas cotidianas responde este artículo») embebidos como chunk auxiliar | `resumenes.ts` + workflow | Cierra el hueco «el 29-A CFF no se parece a "¿qué datos lleva mi factura?"» |
| Herramientas del agente | `tools.ts` | `search_fiscal_knowledge`, `get_articulo` (unidad completa), `get_valor_fiscal` (multas, tarifas, UMA, recargos, ISN por entidad) |
| Valores fiscales tipados desde la fuente oficial, por PR | `src/lib/fiscal/fuentes/*` | Anexo 5 y 8 RMF, LIF, INEGI; workflow abre PR con el diff |
| Pase de verificación de citas (post-respuesta, con la unidad completa; sólo contradicciones) | `verificacion.ts` | Construido; **opt-in** (`AI_VERIFICACION=1`) porque la primera medición empeoró el número |
| Eval con tres capas (recuperación sin LLM, agente real, juez Opus) | `src/lib/ai/eval/` | 96 preguntas doradas; fundamento correcto 97–98 %, «no inventa» 88–91 % |
| Refresco semanal idempotente por hash + cierre de versión | `.github/workflows/fiscal-kb-refresh.yml` | Lunes 00:00 CT |
| Medición de costo por llamada y guardia de uso de IA por empresa/usuario | `src/lib/costos/*`, `guardia.ts` | Cada embedding, rerank, resumen y verificación deja `CostEvent` |

Lo que importa de esta lista: **el motor es genérico en un 80 %**. Lo fiscal está
en el catálogo de fuentes, en la regex de claves, en el prompt y en las
preguntas del eval. No está en el esquema ni en la búsqueda.

---

## 3. Las cinco decisiones

### 3.1 Un solo corpus, dos alcances

No hay «KB fiscal» y «KB legal»: hay **un corpus etiquetado por materia y
ámbito**. Cada documento lleva `materias` (fiscal, contable, laboral,
seguridad_social, mercantil, civil, familiar, penal, administrativo,
constitucional, amparo, pld, ambiental, …) y `ambito` (federal / estatal +
entidad / internacional).

- El copiloto de Contabilidad OS busca **con filtro**: el conjunto que un
  contador cita (fiscal, contable, laboral, seguridad social, mercantil, pld,
  estatal-fiscal). El filtro lo fija el servidor, no el modelo. El «Alcance» del
  prompt sigue declinando lo que no es contable, y así el copiloto no se vuelve
  un abogado gratuito aunque el corpus lo permita.
- El producto legal busca **sin filtro** (o con el filtro que el abogado elija:
  «sólo civil», «sólo Jalisco»).

Ventaja: una sola ingesta, un solo refresco, un solo eval de recuperación. La
misma tesis de la 2a. Sala sobre deducciones la ve el contador y el abogado.

### 3.2 Dónde vive: la misma Postgres, el mismo esquema (hasta que la jurisprudencia diga otra cosa)

Doctrina del repo (`docs/INTEGRATION-GUIDE-SATELLITE-APPS.md`): **una base, un
auth**. Las leyes completas (317 ordenamientos federales, ver §4) son pequeñas:
LISR son 313 páginas → 327 chunks; el catálogo entero cabe en decenas de miles
de chunks, menos de 5 USD de embeddings, minutos de ingesta. Entra en la Postgres
del hub sin discusión.

La **jurisprudencia es otra escala** (cientos de miles de tesis desde 1917;
la 9a. a 12a. Época concentran lo que se cita hoy). A 1536 dims × 4 bytes, cada
tesis son ~6 KB de vector más el índice HNSW: 300 k tesis ≈ 1.8 GB + índice.
Es soportable, pero se **mide en la Fase 1 antes de decidir** entre (a) misma
base con `halfvec` (mitad de tamaño) y sólo 9a.–12a. Época, o (b) base propia
para el corpus, con el hub llamándola por HTTP. Este documento asume (a) y deja
(b) como salida explícita si el número lo pide.

Las tablas siguen llamándose `FiscalDocument` / `FiscalChunk`: renombrar no
compra nada y toca cada consulta cruda. Se **agregan columnas**, no tablas.

### 3.3 El frontend legal es un satélite

Igual que bartiz o credipro: React SPA sin base de datos ni auth propia,
bearer JWT del hub, CORS allowlisted, gateado por `CompanyModule = JURIDICO`.
El hub expone `/api/juridico/*` (chat, expedientes, documentos, redacción). Se
reutilizan tal cual: auth, membresías, guardia de IA y `CostEvent`, historial
de chat, acciones pendientes, verificación, eval.

El tenant del producto legal es una `Company` (el despacho jurídico tiene RFC;
también sirve para el despacho contable que ya es cliente y quiere el módulo).

### 3.4 La jurisprudencia se versiona con el mismo mecanismo que las reformas

Una tesis no «se reforma», pero **cambia de estatus**: jurisprudencia vs.
aislada; obligatoria a partir de la fecha de publicación en el SJF (la «nota de
publicación» lo dice: «se considera de aplicación obligatoria a partir del lunes
25 de agosto de 2025»); puede ser interrumpida, sustituida o superada por
contradicción de criterios. Eso es exactamente `vigenciaDesde` /
`vigenciaHasta` más un `estadoCriterio`. La búsqueda por fecha ya existe: una
pregunta sobre un juicio de 2022 recupera la jurisprudencia obligatoria
entonces.

El agente debe **saber distinguir** (prompt + cita): «Jurisprudencia 2a./J.
10/2024 (11a.)» obliga a los tribunales; una tesis aislada orienta. Esa
distinción es el equivalente jurídico de «la ley va antes que el reglamento» que
ya aprendió el rerank.

### 3.5 Nada entra sin eval

Regla vigente del copiloto: «lo que no mueve el número, no se queda». Se
extiende: **cada materia nueva llega con 20–40 preguntas doradas revisadas por
un abogado** (fundamento esperado en ley y, donde aplique, la tesis esperada).
Las métricas existentes se reusan sin cambio: recuperación top-6, cita presente,
citas fuera de la KB, juez. Se agrega una: **tesis pertinente** (¿la tesis
esperada está en el top-6 de `search_jurisprudencia`?).

El eval fiscal actual es la **prueba de no regresión**: agregar 300 leyes al
corpus no puede bajar el 65 % de recuperación del contador. Si baja (ruido de
vecinos de otras materias), el filtro de materias del hub es el primer sospechoso
y el rerank el segundo.

---

## 4. Fuentes verificadas (11-sep-2026)

| Fuente | Qué | Acceso comprobado | Uso |
|---|---|---|---|
| **Cámara de Diputados — LeyesBiblio** | **317 ordenamientos vigentes** en el índice (CPEUM, códigos federales y nacionales, leyes federales y generales, LIF/PEF 2026) + reglamentos en `/regley`. Cada ley tiene `ref/<clave>.htm` con **todos los decretos de reforma** (fecha DOF, PDF y Word) y el texto original. | El pipeline actual ya ingiere 15 de ellas; mismo formato de PDF. Página `ref` legible sin JS. | Fase 0. Catálogo generado desde el índice, no a mano. |
| **Orden Jurídico Nacional (SEGOB)** | Legislación de las 32 entidades, `estatal.php?edo=1..32`; cobertura desigual (`liberado=si/no`). | Página servida sin bloqueo. Cada congreso estatal publica distinto (Puebla OJP y CDMX Consejería ya resueltos en el chunker). | Fase 3, por entidad y por demanda de clientes. |
| **SCJN — Semanario Judicial de la Federación** (`sjf2.scjn.gob.mx`) | Tesis desde 1917 (5a.–12a. Época), precedentes, votos, acuerdos. Microservicio público `…/services/sjftesismicroservice/api/public/tesis`. | **Detrás de Incapsula**: `curl` recibe 403; un navegador pasa (Firecrawl devolvió la tesis 2031002 completa con todos sus campos). El microservicio pedido a secas responde 403 «Formato inválido» (exige el formato/cabeceras de la SPA): usar el API de datos abiertos, no éste. | Fase 1, vía el worker Playwright que ya existe para el SAT, si la API abierta no basta. |
| **SCJN — Datos abiertos (Repositorio del Bicentenario)** `bicentenario.scjn.gob.mx/repositorio-scjn/sjf` | **API JSON verificada el 2026-09-11** (pestaña «API», que se pinta por JS): base `https://bicentenario.scjn.gob.mx/repositorio-scjn/api/v1/`; `GET tesis/count` → **311 965**; `GET tesis/ids?page=N&size=1000` (páginas **base 0**, máximo 1 000 por página, ids descendentes, `limit` se ignora; 312 páginas para todo); `GET tesis/:id` → objeto con `idTesis`, `rubro`, `texto` (Hechos / Criterio jurídico / Justificación), `precedentes`, `epoca` («Undécima Época»), `instancia`, `organoJuris`, `fuente`, `tesis` (número de identificación, «1a./J. 215/2025 (11a.)»), `tipoTesis` (Jurisprudencia / Tesis Aislada), `localizacion`, `anio`, `mes`, `notaPublica` (fecha de publicación y **desde cuándo es obligatoria**), `anexos`, `huellaDigital` (SHA-256), `materias[]`. Además CSV por lotes de 100 con acuse. | **Incapsula**: `curl` recibe la página «Loading» del reto JS; un navegador real pasa (Firecrawl obtuvo count, ids y dos tesis completas). Sin filtro por Época en el API: se bajan todos los ids y se filtra por `epoca` al leer cada tesis. | Fase 1, fuente preferida (oficial, con hash). Ingesta: el worker Playwright abre la página una vez y llama al API desde el contexto de la página (o reutiliza las cookies `incap_ses_*`/`visid_incap_*` en `fetch` hasta que vuelva el reto); 312 páginas de ids + una petición por tesis. |
| **TFJA — Sistema de Consulta de Tesis y Jurisprudencias** | Tesis y jurisprudencia administrativa/fiscal (la que más cita un fiscalista en litigio). | Formulario, exige elegir Época, sin API ni exportación documentada. | Fase 3, Playwright. |
| **DOF** | Reformas diarias; es la fuente primaria de las versiones. | Bloquea bots y el certificado falla desde el contenedor (medido en la capa de valores). | Fase 3, Playwright; hoy la reforma llega vía Diputados en días. |
| **Tratados (SRE, cja.sre.gob.mx)** | Tratados internacionales vigentes (convenios para evitar doble tributación, T-MEC). | No verificado. | Opcional. |

Lo que NO se puede: reconstruir automáticamente el texto vigente de una ley en
una fecha anterior a su primera ingesta. Diputados publica los decretos de
reforma, no consolidados históricos; reconstruirlos es trabajo manual por ley y
sólo se hace si un cliente lo necesita (litigio sobre ejercicios viejos).

---

## 5. Cambios concretos por archivo

### 5.1 Esquema (`prisma/schema.prisma`)

```prisma
enum FiscalSource { LEY RMF CRITERIO DOF REGLAMENTO TESIS GUIA SENTENCIA TRATADO }
enum AmbitoJuridico { FEDERAL ESTATAL MUNICIPAL INTERNACIONAL }
enum TipoCriterio { JURISPRUDENCIA AISLADA }
enum EstadoCriterio { VIGENTE INTERRUMPIDA SUSTITUIDA SUPERADA }

model FiscalDocument {
  // … lo de hoy …
  materias       String[]        @default([])   // "fiscal", "laboral", "civil", …
  ambito         AmbitoJuridico  @default(FEDERAL)
  entidad        String?                        // "PUE", "CMX" (clave INEGI de 3 letras)
  // Sólo TESIS / SENTENCIA:
  registro       String?         @unique        // registro digital SJF
  epoca          String?                        // "11a."
  instancia      String?                        // "Primera Sala", "TCC"
  organo         String?
  tipoCriterio   TipoCriterio?
  estadoCriterio EstadoCriterio?
  fechaPublicacion DateTime?                    // viernes de publicación en el SJF
}
```

`FiscalChunk` no cambia. El filtro por materias va en el `JOIN` que la búsqueda
ya hace con `FiscalDocument` (`d."materias" && $1::text[]`), sin denormalizar
hasta que el plan de la consulta lo pida. `embedding` se mantiene en 1536; el
cambio a `halfvec` es una migración aparte si la Fase 1 lo justifica (§3.2).

### 5.2 Catálogo generado (`src/lib/fiscal-kb/catalogo/`)

- `scripts/fiscal-catalogo-diputados.ts`: lee el índice de LeyesBiblio, emite
  `catalogo/federal.json` con `{ clave, titulo, urlPdf, urlRef, materias }`.
  Las materias se asignan por regla (nombre de la ley → materia) y se revisan a
  mano una vez; el JSON entra por PR como hoy entran los valores fiscales.
- `ingest-leyes.ts`: `LEYES` se convierte en `catalogo/federal.json` +
  `catalogo/overrides.ts` (lo que hoy es manual: `vigenciaFallback`, fuentes
  estatales con URL propia, reglamentos con nombre de archivo fechado).
- `fusion.ts`: `CLAVES` se deriva del catálogo (hoy es un string literal de 21
  claves). Nuevas referencias exactas: «tesis 1a./J. 215/2025», «registro
  2031002», «jurisprudencia 2a./J. 10/2024».
- `fiscal-kb-refresh.yml`: un job por fuente ya no escala a 317; el endpoint
  `POST /api/admin/fiscal-ingest` acepta `{ "jobs": "catalogo" }` y procesa por
  lotes con el hash (sólo re-embebe lo reformado; una semana normal son 0–3
  leyes).

### 5.3 Chunker (`chunk.ts`)

- `DocKind` gana `"tesis"` (unidad = la tesis completa: rubro + texto +
  precedentes; el rubro va en `contexto`, el registro en `articulo`) y
  `"sentencia"` (unidad = considerando; rara vez se cita, Fase 3).
- La CPEUM y los códigos usan `chunkLaw` tal cual (el chunker ya acepta
  «Artículo 1o.», «ARTÍCULO 158.-», «30 Bis», transitorios).

### 5.4 Búsqueda y herramientas (`search.ts`, `tools.ts`, `tool-executor.ts`)

- `searchFiscalKnowledge` gana `materias?: string[]` y `ambito?/entidad?`.
- `buildCita` para TESIS: «Jurisprudencia 1a./J. 215/2025 (11a.), reg. 2031002»
  / «Tesis aislada I.4o.A.12 A (11a.), reg. 2031551». La regex de
  `extraerCitas` (eval y verificación) aprende ese formato.
- Nuevas: `search_jurisprudencia(query, materia?, epoca?, tipo?, fecha?)` y
  `get_tesis(registro)` (equivalente de `get_articulo`).
- En el hub, `search_fiscal_knowledge` fija `materias` al conjunto contable
  **en el executor**, no en el prompt. `search_jurisprudencia` en el hub queda
  limitada a materia administrativa/fiscal/laboral (un contador sí cita la
  jurisprudencia de la 2a. Sala sobre deducciones; no la civil).
- El pase de verificación coteja citas de tesis con `get_tesis` igual que hace
  con `get_articulo`.

### 5.5 Resúmenes y rerank

- Resúmenes por unidad: se corren para las leyes nuevas (mismo workflow). Las
  tesis **no** los necesitan: el rubro ya es el resumen y la tesis entera es una
  unidad.
- El prompt del rerank gana el criterio «jurisprudencia antes que tesis aislada;
  la Época más reciente antes que una superada» y deja de presentarse como
  «fiscalista» cuando la consulta viene del producto legal (parámetro `perfil`).

### 5.6 Prompt y eval

- `system-prompt.ts` se divide: un núcleo común (fecha, reglas de fundamento,
  verificación, estilo) y dos perfiles: `contador` (el de hoy, sin cambios de
  comportamiento) y `abogado` (rol, alcance, jurisprudencia obligatoria vs.
  aislada, vigencia y Época, confidencialidad, «no sustituye al abogado»,
  prohibido presentar nada ante autoridad).
- `src/lib/ai/eval/preguntas-juridico.ts`: preguntas por materia con
  `fundamentos` y `tesisEsperadas`; el runner existente las corre con el perfil
  `abogado`.

---

## 6. El producto legal (segundo frontend)

Todo lo de abajo se construye **sobre las mismas herramientas** del §5; lo nuevo
es el expediente y la redacción.

| Capacidad | Cómo se construye | Qué protege |
|---|---|---|
| **Consulta** («¿procede el amparo contra…?», «¿qué plazo tengo para contestar la demanda?») | Chat con `search_fiscal_knowledge` sin filtro + `search_jurisprudencia` + `get_articulo` / `get_tesis`. Verificación de citas **siempre encendida** (aquí el costo lo paga el precio del módulo). | Citas con vigencia y Época; «sin fundamento» explícito. |
| **Leer un contrato o una demanda** | Subir PDF/DOCX (pdf-parse ya está; DOCX con `mammoth`) → texto → `Expediente` + `DocumentoJuridico` por Company. Análisis: partes, objeto, obligaciones, plazos, penas, cláusulas atípicas o nulas; en demandas: vía, prestaciones, hechos, pruebas, plazos procesales. **Las citas que el documento hace se cotejan contra la KB** con el mismo pase de verificación (aplicado al documento del cliente, no a la respuesta del modelo). | Nunca se resume sin decir qué no se pudo verificar. |
| **Redactar un contrato** | Biblioteca de plantillas y cláusulas versionadas por materia y entidad (entra por PR, como los valores fiscales). El modelo arma con los datos del expediente y con fundamentos recuperados; cada cláusula con fundamento sale marcada «verificado» / «no verificado». Export DOCX. | El abogado revisa; el producto no firma ni envía. |
| **Redactar una demanda o escrito** | Estructura por vía, con el **checklist de requisitos tomado de la ley por `get_articulo`** (amparo indirecto: Ley de Amparo; contencioso administrativo: LFPCA; mercantil: CCom; civil/familiar: CNPCF; laboral: LFT). Hechos del expediente, conceptos de violación / agravios con jurisprudencia recuperada. | Igual: marcas de verificación por párrafo; nada se presenta. |
| **Expediente** | Tabla nueva `Expediente` (Company, asunto, vía, partes, plazos) con `DocumentoJuridico[]` y el hilo de chat asociado (el `ChatMessage` ya tiene conversación por empresa). | Aislamiento por tenant; retención configurable; los documentos no salen del tenant ni entran a entrenamiento. |

Guardrails no negociables: «no sustituye asesoría profesional» (ya en el
prompt), nada irreversible (no presenta, no notifica, no firma), topes de IA por
tier (`guardia.ts`) con un tier `JURIDICO` propio, y los términos de uso con
revisión de abogado (`docs/LEGAL-ACEPTACIONES.md` ya tiene el borrador y la nota
de que un abogado debe revisarlos).

Distribución: repositorio propio del satélite (como Automotriz / Hospital),
módulo `JURIDICO` en el hub, orígenes en `API_ALLOWED_ORIGINS`. Cliente
objetivo: despachos jurídicos y venta cruzada a los despachos contables que ya
son clientes (un despacho contable litiga ante el TFJA y contesta requerimientos:
ahí el módulo legal y el contable se tocan).

---

## 7. Fases y criterio de salida

| Fase | Alcance | Duración | Sale cuando |
|---|---|---|---|
| **F0 — Corpus federal completo** | Catálogo generado desde Diputados (317 ordenamientos + reglamentos), etiquetas de materia/ámbito, filtro de materias fijo en el hub, `CLAVES` derivadas, refresco por lotes, resúmenes para lo nuevo. | 1 semana | Todo ingerido y refrescándose solo; **el eval fiscal no baja** (recuperación ≥ 65 %, fundamento correcto ≥ 97 %). |
| **F1 — Jurisprudencia SCJN** | URL base de la API de datos abiertos leída desde navegador; ingesta 9a.–12a. Época (Playwright si la API no alcanza); esquema §5.1; `search_jurisprudencia` + `get_tesis`; cita y verificación; medición de tamaño (§3.2); 40 preguntas doradas legales revisadas por un abogado. | 2 semanas | «Tesis pertinente» ≥ 70 % en top-6; decisión tomada sobre dónde vive el corpus. |
| **F2 — Producto legal MVP** | Satélite: chat con perfil `abogado`, expediente, leer documento con verificación, 3 plantillas de contrato, 1 vía de escrito (amparo indirecto o contencioso administrativo, que además sirve al despacho contable). Módulo `JURIDICO`, tier de IA, términos. | 3–4 semanas | 5 despachos piloto usándolo; costo de IA por despacho medido en `CostEvent`. |
| **F3 — Cobertura** | **Hecho el primer paquete (construcción/urbanismo, 2026-09-11, ver status):** reglamentos federales, NOM, OJN estatal/municipal + curado a mano. Sigue: TFJA (Playwright), el resto de la legislación estatal por demanda, DOF diario, sentencias completas (SIJ), tratados. | Continuo, por demanda | Cada fuente con su eval. |

Costos de construcción del corpus, orden de magnitud: embeddings de las 317
leyes < 5 USD; resúmenes con Haiku ≈ 0.001 USD por artículo (decenas de miles
de artículos → 60–100 USD, una vez); tesis 9a.–12a. Época: unos cuantos USD de
embeddings, el costo real es almacenamiento (§3.2). Consulta: igual que hoy (un
embedding + un rerank por búsqueda, medidos).

---

## 8. Lo que sólo Juan decide

1. **Nombre, precio y tier de IA** del producto legal (¿módulo del hub o marca
   propia con su dominio?).
2. **El abogado revisor**: preguntas doradas por materia, plantillas de contrato
   y términos de uso. El GTM ya contempla «una hora de abogado»; esto son más.
3. **Dónde vive la jurisprudencia** si la medición de F1 pasa de ~2 GB: misma
   Postgres con `halfvec` o base propia.
4. **Responsabilidad profesional**: seguro E&O y qué dice el producto de sí
   mismo (herramienta del abogado, no abogado).
5. **Prioridad de entidades federativas** para la Fase 3 (hoy: Puebla y CDMX).
6. **Orden F1 ↔ F2**: la jurisprudencia primero hace mejor el producto; el
   frontend primero valida demanda antes. La recomendación es F0 → F1 → F2
   porque un producto legal sin jurisprudencia no es creíble para un litigante.
