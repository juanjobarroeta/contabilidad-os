// ─────────────────────────────────────────────────────────────────────────────
// La guía de HospitalOS que lee la mascota de ayuda (ayuda.ts).
//
// Las llaves de página son las del satélite (Hospital/src/auth/paginas.js)
// más Usuarios y Configuración. Al cambiar una pantalla del satélite (botón,
// pestaña, flujo) hay que actualizar aquí su sección: la mascota sólo sabe lo
// que dice esta guía. Las preguntas sin respuesta del tablero
// (/api/hospital/ayuda/preguntas) dicen qué falta.
// ─────────────────────────────────────────────────────────────────────────────

export const PAGINAS_AYUDA: readonly { key: string; label: string; ruta: string }[] = [
  { key: "panel", label: "Panel de dirección", ruta: "/panel" },
  { key: "alertas", label: "Requiere atención", ruta: "/alertas" },
  { key: "censo", label: "Censo y camas", ruta: "/censo" },
  { key: "agenda", label: "Agenda", ruta: "/agenda" },
  { key: "pacientes", label: "Pacientes", ruta: "/pacientes" },
  { key: "episodios", label: "Expedientes", ruta: "/episodios" },
  { key: "caja", label: "Caja", ruta: "/caja" },
  { key: "facturacion", label: "Facturación", ruta: "/facturacion" },
  { key: "cuentas", label: "Cuentas", ruta: "/cuentas" },
  { key: "cotizaciones", label: "Cotizaciones", ruta: "/cotizaciones" },
  { key: "convenios", label: "Convenios y tarifario", ruta: "/convenios" },
  { key: "protocolos", label: "Protocolos", ruta: "/protocolos" },
  { key: "medicos", label: "Médicos y honorarios", ruta: "/medicos" },
  { key: "farmacia", label: "Farmacia y almacén", ruta: "/farmacia" },
  { key: "compras", label: "Compras", ruta: "/compras" },
  { key: "requisiciones", label: "Requisiciones", ruta: "/requisiciones" },
  { key: "clientes", label: "Clientes", ruta: "/clientes" },
  { key: "proveedores", label: "Proveedores", ruta: "/proveedores" },
  { key: "tesoreria", label: "Tesorería", ruta: "/tesoreria" },
  { key: "bancos", label: "Bancos", ruta: "/bancos" },
  { key: "nomina", label: "Nómina", ruta: "/nomina" },
  { key: "mantenimiento", label: "Mantenimiento", ruta: "/mantenimiento" },
  { key: "registros", label: "Registro diario", ruta: "/registros" },
  { key: "cumplimiento", label: "Cumplimiento y evidencia", ruta: "/cumplimiento" },
  { key: "saeh", label: "SINBA · Egresos", ruta: "/saeh" },
  { key: "contabilidad", label: "Contabilidad del hospital", ruta: "/contabilidad" },
  { key: "estado-resultados", label: "Estado de resultados", ruta: "/estado-resultados" },
  { key: "balance", label: "Balance general", ruta: "/balance" },
  { key: "impuestos", label: "Impuestos", ruta: "/impuestos" },
  { key: "usuarios", label: "Usuarios", ruta: "/usuarios" },
  { key: "preguntas", label: "Preguntas a la mascota", ruta: "/preguntas" },
  { key: "configuracion", label: "Configuración", ruta: "/configuracion" },
];

export const CONOCIMIENTO = `# General

**HospitalOS** es la aplicación web (también instalable en el teléfono) para hospitales privados. Es un «satélite» de **ContabilidadOS**: no tiene usuarios ni base de datos propios; todo se guarda en el hub de ContabilidadOS, en empresas que tienen habilitado el módulo **Hospital**.

**La cadena del producto: expediente → cuenta → factura → banco → contabilidad.** Lo que se registra en el expediente (estancia, aplicaciones de medicamentos, cargos) cae en la cuenta del paciente; la cuenta se factura (prefactura → timbrado); el cobro se concilia en el banco; y la póliza contable nace con el CFDI. En la cuenta del paciente se ve esta cadena como «De la cama al libro contable»: Registrado en piso → Cargado a la cuenta → Factura timbrada → Cobro conciliado en banco → Póliza contable generada sola.

Conceptos que se confunden: el **paciente** es la persona atendida; el **cliente** es el receptor fiscal del CFDI (el propio paciente, su empresa o la aseguradora); el **convenio** (pagador) es quien paga la cuenta.

## Iniciar sesión
- Se entra con la **misma cuenta (correo y contraseña) de ContabilidadOS**. Pantalla: campos «Correo» y «Contraseña», botón **Entrar**.
- Si ninguna empresa del usuario tiene el módulo, aparece: «Ninguna de tus empresas tiene el módulo Hospital habilitado. Pídelo en ContabilidadOS.»
- Al entrar, la app abre la última empresa (hospital) usada por ese usuario y aterriza en la primera página que tiene permitida (normalmente el Panel).
- Si la sesión venció: «Tu sesión no es válida o venció. Vuelve a iniciar sesión.»
- **Cerrar sesión**: en el pie del riel (debajo del nombre), en **Configuración** o en la hoja «Más» del teléfono.

## Navegación
- **Riel lateral (escritorio)** organizado por área, igual para todos; sólo cambia qué páginas se ven:
  - **Dirección**: Panel, Requiere atención.
  - **Piso**: Censo y camas, Agenda, Pacientes, Expedientes.
  - **Caja**: Caja, Facturación, Cuentas, Cotizaciones, Convenios y tarifario, Protocolos, Médicos y honorarios.
  - **Farmacia**: Farmacia y almacén, Compras, Requisiciones.
  - **Administración**: Clientes, Proveedores, Tesorería, Bancos, Nómina, Mantenimiento, Registro diario, Cumplimiento y evidencia, SINBA · Egresos.
  - **Contabilidad**: Contabilidad del hospital, Estado de resultados, Balance general, Impuestos.
  - Pie del riel: **Usuarios** (sólo dueño o administrador), **Configuración**, nombre del usuario y «Cerrar sesión». El botón junto al logo colapsa/expande la barra («Colapsar la barra» / «Expandir la barra»); se recuerda.
  - Un grupo sin páginas visibles desaparece del riel.
- **Barra superior**: selector de hospital (empresa), buscador «Buscar paciente, expediente, insumo, RFC…», interruptor de tema **Claro / Oscuro**, campana que abre «Requiere atención».
- **Teléfono**: barra inferior con **4 destinos + «Más»**. Los 4 destinos se eligen solos según las páginas que la persona puede ver, en este orden de prioridad: Camas (censo), Expediente, Pacientes, Agenda, Cuentas, Cotizar, Farmacia, Compras, Mantto., Atención, Panel. Quien ve todas las páginas (dirección) tiene: Panel, Camas, Pacientes, Atención. **«Más»** abre el árbol completo, el selector de hospital, Usuarios (si es admin), Configuración, «Instalar en este teléfono» (si aplica), el tema y «Cerrar sesión».
- **Instalar la app**: aparece una vez el aviso «Tenla a la mano» con **Instalar** o «Ahora no»; en iPhone indica tocar **Compartir** → «Añadir a pantalla de inicio». Después queda en «Más».
- **Versión nueva**: aparece «Hay una versión nueva de la aplicación.» con botón **Actualizar** (no recarga sola para no borrar lo que se está capturando).
- **Paleta de comandos / buscador**: **Ctrl K** (en Mac **⌘K**) o clic en el buscador de la barra superior. Escribe al menos 2 letras («Escribe una letra más para buscar.» si hay una). Resultados agrupados: **Ir a** (páginas que puedes ver, más «Usuarios y permisos» si eres admin y «Configuración»), **Pacientes**, **Expedientes**, **Farmacia** (insumos) y **Directorio** (clientes/proveedores por RFC). Teclas: ↑↓ moverse, ↵ abrir, esc cerrar.
- **Selector de hospital (empresa)**: botón con el nombre del hospital arriba a la izquierda (en el teléfono, dentro de «Más»). Lista «Tus hospitales» con razón social y RFC; sólo muestra empresas con el módulo Hospital. Cambiar de hospital cambia todos los datos y los permisos (cada hospital tiene sus propios permisos para la persona).
- **Tema**: Claro (default) u Oscuro; se guarda por usuario.
- Si una pantalla falla al dibujarse aparece «Algo se rompió» con **Reintentar**; antes de repetir un envío conviene revisar si quedó registrado.

# Permisos

Hay tres capas: **qué páginas ve** la persona, **qué acciones puede hacer** y su **rol**. Las decide un administrador en **Usuarios**.

## Visibilidad de páginas
- Cada persona tiene una lista de páginas permitidas por hospital. **Lista vacía = ve todas las páginas** (incluidas las que se agreguen después).
- Las páginas no permitidas no aparecen en el riel, en la barra del teléfono ni en el buscador. Si se teclea la URL a mano, la app **redirige a la primera página permitida** (sin mensaje).
- Excepciones: **Configuración** siempre entra; **Usuarios** sólo dueño o administrador.
- Páginas que se abren por otra: quien ve **Caja** o **Cuentas** también puede abrir **Facturación**; quien ve **Compras** o **Tesorería** también abre **Requisiciones**.
- Las páginas de detalle heredan la de su lista: /pacientes/:id → Pacientes; /episodios/:id → Expedientes; /cuentas/:id → Cuentas; /convenios/:id → Convenios; /contactos/:id y /proveedores/padron → Clientes/Proveedores; /planes/:id → Pacientes; /fiscal → Impuestos.
- **Los cambios de páginas aplican en el siguiente inicio de sesión de la persona; las acciones, de inmediato.** Si a alguien le acaban de dar una página y no la ve, debe **cerrar sesión y volver a entrar**.
- En **Configuración → Tu cuenta → Páginas** cada quien ve «todas» o «N de 29 — las decide Usuarios».
- Si la API rechaza la sección: «Tu usuario no tiene acceso a esta sección del hospital. Pide a un administrador que habilite esta sección en Usuarios.»

**«¿Por qué no veo Nómina (u otra página)?»** Porque no está en tu lista de páginas en este hospital. Pide a un administrador (dueño o admin) que la marque en **Usuarios** (o que te asigne un puesto que la incluya); luego cierra sesión y vuelve a entrar. Revisa también que estés en el hospital correcto en el selector de empresa.

## Puestos (perfiles)
Un **puesto** junta páginas + acciones. En Usuarios → pestaña **Puestos** se pueden crear con **Nuevo puesto** o cargar con **Cargar puestos sugeridos**. Los sugeridos:
- **Dirección**: ve todas las páginas; Leer expediente, Operaciones financieras, Autorizar compras, Autorizar pagos.
- **Médico**: Requiere atención, Censo, Agenda, Pacientes, Expedientes, Protocolos; Leer expediente, Documentar atención, Registrar indicaciones médicas, Dar de alta.
- **Enfermería**: Censo, Agenda, Pacientes, Expedientes, Farmacia; Leer expediente, Documentar atención, Registrar aplicaciones.
- **Admisión**: Requiere atención, Censo, Agenda, Pacientes, Expedientes, Cotizaciones, Convenios; Leer, Documentar y Programar agenda.
- **Caja**: Caja, Facturación, Pacientes, Expedientes, Cuentas, Cotizaciones, Convenios, Protocolos, Clientes, Bancos; Leer expediente y Operaciones financieras.
- **Farmacia**: Expedientes, Farmacia, Compras, Requisiciones, Proveedores; Leer expediente.
- **Compras**: Requisiciones, Compras, Proveedores, Farmacia; sin acciones especiales.
- **Tesorería**: Tesorería, Bancos, Requisiciones, Compras, Proveedores; Operaciones financieras y Tesorería: registrar pagos.
- **Contabilidad**: Cuentas, Facturación, Farmacia, Compras, Requisiciones, Tesorería, Clientes, Proveedores, Bancos, Nómina, Contabilidad, Estado de resultados, Balance, Impuestos, Médicos, SINBA; Operaciones financieras.
- **Mantenimiento**: sólo Mantenimiento.
Sobre el puesto se pueden hacer ajustes por persona (páginas o acciones «extra» o «quitada»). «Ver todas las páginas» es exclusivo del puesto Dirección.

## Acciones (permisos del hub)
| Permiso | En Usuarios se llama | Qué permite |
|---|---|---|
| CLINICA_LEER | Leer expediente | Consultar expedientes, pacientes, censo, agenda y SINBA. Cada lectura queda en la bitácora de accesos. |
| CLINICA_ESCRIBIR | Documentar atención | Notas, signos, ingresos, traslados, documentos y la hoja SAEH. Requiere Leer expediente. |
| ADMINISTRAR | Registrar aplicaciones | Aplicar medicamento o insumo al paciente: descuenta inventario y genera el cargo. |
| PRESCRIBIR | Registrar indicaciones médicas | Capturar indicaciones (nota tipo Indicación). Para firmar necesita identidad médica verificada. |
| ALTA | Dar de alta | Registrar la salida del paciente con el alta firmada por el médico. |
| AGENDA_PROGRAMAR | Programar agenda | Agendar, editar, mover, confirmar o cancelar citas de quirófano, endoscopia y consultorio. Sin él la agenda es de sólo consulta. |
| FINANZAS_ESCRIBIR | Operaciones financieras | Cobrar, facturar, depósitos, cargos a la cuenta, bancos, nómina, tesorería, contabilidad y datos de pago de proveedores. |
| COMPRAS_AUTORIZAR | Autorizar compras | Autorizar o rechazar requisiciones de otros (nunca la propia). |
| PAGOS_AUTORIZAR | Autorizar pagos | Mandar a tesorería el pago de una orden que no pidió. |
| TESORERIA_PAGAR | Tesorería: registrar pagos | Registrar el pago de lo que otra persona autorizó. |

Reglas del servidor:
- Leer páginas clínicas (pacientes, expedientes, censo, agenda, SINBA, panel, registros) exige **CLINICA_LEER**; dueño y administrador pueden leer sin él, pero para escribir todos necesitan el permiso.
- Escribir en lo clínico exige **CLINICA_ESCRIBIR**; agendar o mover citas (y programar un plan) exige **AGENDA_PROGRAMAR**; registrar una aplicación exige **ADMINISTRAR**; una indicación exige **PRESCRIBIR**.
- Escribir en cuentas, caja, depósitos, cobros, bancos, contabilidad, liquidaciones, facturación, nómina o tesorería exige **FINANZAS_ESCRIBIR** (y no ser Sólo lectura).
- **Autorizar alta** requiere ALTA + Documentar atención + identidad médica verificada; **Registrar salida** requiere ALTA + Documentar atención.
- Segregación del ciclo de compras: nadie autoriza su propia requisición, quien pidió no autoriza el pago, y quien autorizó el pago no lo registra.

## Roles
- **Dueño (OWNER)** y **Administrador (ADMIN)**: administran usuarios, guardan Configuración y Cumplimiento. El dueño se administra a sí mismo o en ContabilidadOS; a un administrador sólo lo cambia el dueño; tu propio acceso lo cambia el dueño.
- **Operativo (ACCOUNTANT)**: trabaja según su puesto.
- **Sólo lectura (VIEWER)**: nunca escribe, aunque tenga acciones.

## Mensajes de error que ve el usuario (y qué hacer)
- «Tu usuario no tiene permiso para **consultar expedientes clínicos** / **escribir o modificar información clínica** / **registrar la aplicación de medicamentos o insumos** / **dar de alta a pacientes** / **registrar indicaciones médicas** / **registrar o modificar operaciones financieras** / **autorizar requisiciones de compra** / **autorizar pagos a proveedores** / **registrar pagos de tesorería** en este hospital. Pide a un administrador que habilite este acceso en Usuarios.» → Un admin debe marcar la acción correspondiente en Usuarios (aplica de inmediato).
- «Tu usuario no tiene acceso a esta sección del hospital. Pide a un administrador que habilite esta sección en Usuarios.» → Falta la página.
- «Sólo un administrador del hospital puede realizar esta acción. Contacta al administrador de tu hospital.» → Usuarios, puestos, Cumplimiento o guardar Configuración.
- «Tu usuario sólo puede consultar información. Para guardar cambios, pide acceso de escritura al administrador de tu hospital.» → Rol Sólo lectura; cambiar a Operativo.
- «No puedes firmar como médico con este usuario. Un administrador debe vincular tu cuenta a tu perfil médico y verificar tu cédula en Usuarios. Si ya tienes un perfil verificado, debes firmar con tu propia identidad.» → Usuarios → la persona → Identidad médica → Vincular (lo hace otro administrador, no uno mismo).
- «Tu acceso médico de demostración sólo permite firmar en el paciente DEMO habilitado…» → acceso demo.
- Genéricos: «Tu usuario no tiene permiso para realizar esta acción. Pide al administrador de tu hospital que revise tu acceso.» (403); «No encontramos el registro solicitado. Actualiza la lista y vuelve a seleccionarlo.» (404); «No se pudo guardar porque el registro cambió o la acción entra en conflicto con su estado actual. Actualiza la información y revísala.» (409); «Revisa los datos del formulario…» (400); «Has realizado demasiadas solicitudes seguidas…» (429); «El archivo es demasiado grande…» (413); «No pudimos comunicarnos con el servicio. Revisa tu conexión…» (sin red); errores del servidor: «No pudimos completar la solicitud por un problema del servicio. Si estabas guardando cambios, revisa si quedaron registrados antes de volver a intentarlo.»

# Páginas

## usuarios — Usuarios (/usuarios)
- **Para qué**: dar de alta personas y decidir qué ve y qué puede hacer cada una. Sólo **dueño o administrador** (a otros les sale «Sólo el dueño o un administrador pueden administrar usuarios.» y no aparece en el riel).
- **Qué se ve**: pestañas **Personas** y **Puestos**. Tabla de personas: Persona, Puesto, Rol, Acceso, Identidad médica, Avisos (contador de inconsistencias, p. ej. «Ve páginas clínicas pero sin «Leer expediente» no podrá abrir ningún paciente.» o «Sólo lectura no escribe…»).
- **Crear usuario**: **Nuevo usuario** → Nombre, Correo, Contraseña (mínimo 8 caracteres), Rol (Operativo / Sólo lectura), Puesto (puestos del hospital o sugeridos, que se crean al guardar) → **Crear usuario**. El usuario creado así sólo podrá usar HospitalOS, no ContabilidadOS. Entra con su correo y contraseña.
- **Cambiar acceso**: clic en la persona → panel con Puesto (o «A la medida (sin puesto)»), Rol, **Qué ve** (casillas por área: Dirección, Atención clínica, Caja y cuentas, Farmacia y compras, Finanzas, Operación; o «Todas las páginas»), **Qué puede hacer** (acciones en grupos Atención clínica / Dinero y compras) → **Guardar acceso**. Conceder una acción agrega sola lo que necesita (p. ej. Leer expediente y la página Expedientes).
- **Quitar acceso** → **Confirmar: quitar acceso**.
- **Identidad médica**: en el panel de la persona, **Vincular** / **Cambiar** → elegir Profesional (de Médicos) y «Evidencia revisada» (mínimo 10 caracteres) → **Guardar identidad**. La propia identidad la verifica otro administrador.
- **Puestos**: **Nuevo puesto** (Nombre, Descripción, páginas y acciones → **Crear puesto**), editar → **Guardar puesto**, **Borrar puesto**.
- Todo queda en bitácora. Cambios de páginas: en el siguiente inicio de sesión; acciones: de inmediato.
- **Relacionadas**: Médicos (perfil médico para firmar), Configuración.

## configuracion — Configuración (/configuracion)
- **Para qué**: datos de la cuenta propia y parámetros del hospital. Siempre visible para todos; **guardar** parámetros es sólo para administradores.
- **Tu cuenta** (la misma de ContabilidadOS): Nombre, Correo, Hospital, Rol, Páginas («todas» o «N de 29 — las decide Usuarios»), Tema, **Cerrar sesión**.
- **Hospital**: Nombre del hospital; **Series de folio** (Expediente, Cotización, Ticket); **Umbrales** (Días de alerta de caducidad, Tope de autorización (MXN), IVA de los servicios, IVA de medicinas suministradas en la atención); **Identidad sanitaria** (CLUES, Licencia sanitaria, Responsable sanitario, Cédula del responsable); **Aviso de privacidad** (Versión vigente, URL del aviso integral); **Intercambio CDA** (OID raíz); **SAEH** (Institución para el reporte) → **Guardar**.
- **Textos legales del paquete de admisión**: editar, **Vista previa**, **Guardar textos**.
- **Captura asistida**: activar/desactivar el asistente de IA (estructurar dictado, codificar CIE, proponer nota de egreso, sugerencias SINBA). Si está apagado, los botones de IA del expediente se desactivan («La captura asistida está apagada en Configuración»).
- **Contabilidad del hospital**: interruptor Activa/En pausa (ver Contabilidad).
- **Farmacia desde los CFDIs**: **Derivar ahora** crea insumos y movimientos a partir de los CFDIs (idempotente: no duplica).
- Enlace a Cumplimiento y evidencia sanitaria.

## panel — Panel de dirección (/panel)
- **Para qué**: tablero diario de dirección. Saludo, fecha y enlace «Requiere atención · N →».
- **Qué se ve**: KPIs **Ocupación** (→ censo), **Cirugías hoy** (→ agenda), **Por cobrar** (→ cartera en Cuentas), **Efectivo proyectado** (→ bancos); banda **Impuestos del mes** (IVA a cargo, IVA acreditable, IVA por pagar, ISR retenido a médicos, Se declara → Impuestos); **Movimiento del día** (ingresos, cirugías, altas; «Ver el censo →»); lista **Requiere atención** («Ver todo →»).
- Sólo lectura. Requiere la página Panel (y Leer expediente para lo clínico, salvo admin).
- **Relacionadas**: Requiere atención, Censo, Cuentas, Impuestos.

## alertas — Requiere atención (/alertas)
- **Para qué**: lista de pendientes detectados por el hub. También se abre con la campana de la barra superior.
- **Qué se ve**: facetas por tipo con conteo («Todo», Caducidad, Caducado, Existencia, Sin existencia, Autorización, Expediente, Cobranza, Complemento, Convenio, Mantenimiento, Impuestos, Nómina, Ambulatorio 12 h, Egreso sin CIE, Seguimiento, Identificación, Privacidad, Controlados, Plan sin autorización, Fuera de plan). Cada renglón lleva a donde se resuelve.
- Vacío: «Sin alertas detectadas» — el tablero revisa fuentes específicas y no certifica la preparación del hospital; revisar también Cumplimiento y Configuración.

## censo — Censo y camas (/censo)
- **Para qué**: ver camas ocupadas/libres y abrir el expediente desde la cama. Lo usan enfermería, admisión y dirección.
- **Qué se ve**: «Censo del [fecha]», filtro por área, **Ocupación por área**, KPIs Ocupación, Ingresos hoy, Altas hoy, Estancia promedio; tarjetas de cama (paciente, «Día N», médico, estado; libres «Disponible», «Sin paciente» en limpieza, «Ocupada sin episodio», «Fuera de servicio»); **Movimientos del día**.
- **Acciones**: clic en una cama ocupada → abre su expediente. **Marcar libre** en camas en limpieza. **Agregar recurso** → Tipo (cama, quirófano, consultorio, sala), Área, Nombre («204», «Quirófano 2») → **Agregar**. **Nuevo ingreso** → abre el alta de ingreso en Expedientes.
- Nota: cada noche de estancia se carga sola a la cuenta con la tarifa del pagador.
- **Permisos**: página Censo + Leer expediente; escribir requiere Documentar atención.

## agenda — Agenda (/agenda)
- **Para qué**: reservar quirófanos, endoscopia, consultorios y salas sin empalmes, y llevar la hoja semanal de quirófano (reemplaza el Excel/PDF que se mandaba).
- **Quién la ve y quién la mueve**: la ve quien tiene la página Agenda y «Leer expediente». Sólo quien además tiene **Programar agenda** (AGENDA_PROGRAMAR) ve **Agendar**, **Editar** y los botones de estado; los demás ven «sólo consulta».
- **Qué se ve**: selector **Día** / **Semana** y navegación ◀ **Hoy** ▶. **Día**: columnas por recurso, bloques por hora (07:00–22:00); un «!» en el bloque marca algo pendiente. **Semana**: siete días (Lun–Dom) con cada caso como en la hoja: hora, procedimiento, médico, Px con edad, Dx, anestesiólogo (por confirmar / confirmado) y tipo de anestesia, enfermera, instrumentista, estancia y habitación, insumos y lo que trae proveedor o paciente. Filtro **Todos los recursos** / uno (p. ej. Endoscopia). **PDF de la semana** descarga la hoja para mandarla. Si no hay recursos: «No hay quirófanos, consultorios ni salas» → darlos de alta en Censo (Agregar recurso).
- **Agendar**: botón **Agendar** → Recurso, Tipo, Qué se hace, Paciente (con ficha o sólo el nombre), Médico, Fecha, Inicio, Fin, Diagnóstico; **Equipo**: Anestesiólogo, Tipo de anestesia, «El anestesiólogo ya confirmó», Enfermera, Instrumentista, «Se solicita instrumentista»; **Estancia e insumos**: Ambulatoria/Hospitalización, Habitación, **+ Insumo** (descripción, cantidad, Hospital / Trae proveedor / Trae paciente); Notas → **Agendar**. El hub rechaza empalmes en el mismo recurso. Avisos: «Elige el quirófano, consultorio o sala.», «La hora de fin debe ser después de la de inicio.» Al programar un plan de tratamiento la hoja se llena sola con su anestesiólogo, anestesia, diagnóstico, estancia e insumos.
- **Qué se hace con código**: al escribir en «Qué se hace» aparecen los servicios del tarifario por clave o nombre (↑ ↓ y Enter para elegir); la cita queda ligada a ese código, que se ve en la semana y en los PDF. También se puede escribir libre.
- **Mes**: vista con seis semanas Lun–Dom, hasta tres casos por día y «+N más»; clic en el número abre ese día. **PDF del mes**: calendario del mes con cada caso en una línea (hora, sala, procedimiento y código, médico, paciente en iniciales, «(!)» si falta algo) y las solicitudes por programar del mes.
- **Editar o confirmar**: clic en la cita → **Editar** (mismo formulario) o **Anestesiólogo confirmado**. Cambiar de anestesiólogo lo regresa a «por confirmar».
- **Solicitudes por programar** (lo que antes iba en la hoja 2 del Excel): botón **Solicitud** → recurso, procedimiento, paciente, médico, fecha, **Hora pedida** o «Hora por definir», **Duración** (min) y la hoja → **Guardar solicitud**. No ocupa el recurso ni choca con nada. Aparecen arriba en **Por programar** y en la semana con borde punteado. Clic → **Programar** (se escoge la hora; el fin se calcula con la duración) o **Descartar solicitud**. Al programarla sí se revisan empalmes.
- **Limpieza entre casos**: clic en el encabezado de un quirófano/sala (quien tiene Programar agenda) → «Limpieza entre casos» en minutos; también al **Agregar recurso** en Censo. La rejilla dibuja el hueco rayado después de cada caso y el hub rechaza una cita que no lo respete: «… y necesita 30 min de limpieza entre casos».
- **Pantalla** (TV de pasillo, /agenda/pantalla): lo de hoy por recurso, sólo lectura, paciente en iniciales, se actualiza cada minuto; marca «En curso», «En horario» (ya debió empezar y nadie le dio Iniciar) y «Siguiente». Para un solo recurso se elige en el selector o con «?recurso=» en la dirección. Conviene abrirla con una cuenta de **Sólo lectura** que tenga la página Agenda y «Leer expediente».
- **Cambiar estado de una cita**: clic en la cita → Programada: **Confirmar**, **Iniciar**, **Cancelar cita**; Confirmada: **Iniciar**, **No asistió**, **Cancelar cita**; En curso: **Terminar**. Desde el detalle se abre la ficha del paciente o el expediente.

## pacientes — Pacientes (/pacientes)
- **Para qué**: padrón de pacientes (personas atendidas).
- **Qué se ve**: buscador «Nombre, CURP o teléfono…», facetas **Todos** / **Con saldo pendiente**; columnas Paciente, Edad · sexo, Teléfono, Convenio, Último episodio; paginación Anterior/Siguiente.
- **Dar de alta (registrar) un paciente**: **Nuevo paciente** → asistente por pasos **Identificación** (leer o fotografiar la identificación), **Datos del paciente**, **Adulto responsable**, **Domicilio y SAEH**, **Factura**, **Clínico y convenio** (botones Atrás / Siguiente) → **Registrar paciente**, o **Registrar y abrir ingreso**, que guarda la ficha y abre «Nuevo ingreso» con el paciente ya elegido para capturar el diagnóstico (el diagnóstico es de cada ingreso, no de la ficha). El **teléfono** y el **correo electrónico** del paciente se capturan en **Datos del paciente**, junto al nombre. «Clínico y convenio» trae tipo de sangre, alergias, antecedentes, convenio y aviso de privacidad; el contacto de emergencia es el adulto responsable (si es otra persona) y sólo se pide aparte con «Usar otra persona» o cuando no hay responsable. Obligatorio: nombre y apellido paterno; CURP o marcar «Sin CURP» con motivo (NOM-024); y elegir el adulto responsable.
- **Adulto responsable** (paso 3): quién responde por el paciente y firma los consentimientos y documentos como **representante**. Tres opciones: **Otra persona** (familiar, tutor o representante legal: nombre, apellidos, parentesco, teléfono obligatorios; CURP, fecha de nacimiento, sexo, identificación, correo y domicilio; la casilla «Mismo teléfono, correo y domicilio que el paciente» hace que el responsable use los del paciente: teléfono y correo se capturan una vez, en ese paso o en «Datos del paciente», y el domicilio sale de «Domicilio y SAEH»), **El propio paciente** (mayor de edad; no se puede elegir si es menor) o **Pendiente** (urgencia: se registra después). El responsable debe ser mayor de edad. El adulto responsable es también el contacto de emergencia, salvo que en «Clínico y convenio» se elija «Usar otra persona». En la ficha del paciente, la tarjeta **Adulto responsable** muestra sus datos y «Registrar adulto responsable» / «Editar». Mientras esté pendiente (o el paciente sea menor sin responsable) y tenga un ingreso abierto, el panel muestra la alerta «sin adulto responsable». Al firmar un documento con el rol Representante, su nombre, identificación y parentesco se proponen solos. Con **Foto de su INE** (en el paso del responsable) se toma o elige la foto de la identificación del responsable: llena nombre, apellidos, CURP, fecha de nacimiento y número de identificación (sólo lo que esté vacío) y la imagen se guarda en el expediente del paciente al registrar.
- **Documentos de identidad** (ficha del paciente): lista la identificación del paciente, la del responsable y la constancia de la CURP con **Descargar** (cada descarga queda registrada en Accesos). **Subir constancia de la CURP** (foto o PDF; la oficial se baja de gob.mx/curp). **Imprimir verificación RENAPO**: hoja con lo que contestó RENAPO (CURP, estatus, nombre, si coincide con la ficha, fecha y fuente); requiere haber verificado la CURP y no sustituye a la constancia oficial. Los archivos viven en el hub, ligados al paciente (máximo 10 MB cada uno).
- **Urgencia sin datos completos**: si el paciente llega sin identificación, en Datos marca «Sin CURP» con un motivo (p. ej. «Urgencia: identificación pendiente») y en Adulto responsable elige «Pendiente»; registra el ingreso por Urgencias sin triage y completa todo después. Avisos: «Captura la CURP o marca «Sin CURP» con su motivo (NOM-024).», «El RFC no tiene forma válida…». El número de expediente lo asigna el hub.
- **Permisos**: página Pacientes; leer requiere Leer expediente, registrar/editar requiere Documentar atención.
- **Relacionadas**: ficha del paciente, Expedientes (ingreso), Convenios, Clientes.
- Ojo: «dar de alta a un paciente» puede significar registrarlo (aquí) o darlo de **alta médica/egreso** (ver Expediente).

## Ficha del paciente (/pacientes/:id)
- Encabezado con número de expediente, CURP (✓ si validada) y botones **Editar**, **Nuevo plan**, **Nuevo ingreso**.
- Secciones: Identificación · NOM-024; **Aviso de privacidad** (estado Aceptado / Versión anterior / Sin aceptación; **Firmar en pantalla**; si no hay versión configurada, «Configurar el aviso →» en Configuración); Datos clínicos (tipo de sangre, alergias, antecedentes); Convenio y receptor fiscal; Contacto de emergencia; **Episodios** (con «Registrar ingreso» si no hay); **Planes de tratamiento** (**Nuevo plan**); Citas; Cotizaciones; **Accesos** («Ver quién ha leído esta ficha»); Facturas.
- **Nuevo plan** (plan de tratamiento): Protocolo, Nombre del plan, Pagador, Fecha programada, Médico (cirujano), Anestesiólogo, Quirófano o sala, Notas → **Crear plan**. Desde el plan: **Autorizar** / Número de autorización, **Programar** / Reprogramar (crea la cita en la agenda), **Cotizar**, **Cancelar plan**, **Ver expediente**.
- /planes/:id (enlace desde alertas) abre la ficha con el plan.

## episodios — Expedientes (/episodios)
- **Para qué**: lista de episodios (ingresos). Cada ingreso abre su expediente y su cuenta con el mismo folio.
- **Qué se ve**: buscador «Folio, paciente, médico…», facetas **En curso**, **Dados de alta**, **Todos**, **Históricos (CFDI)** (reconstruidos de facturas: la cuenta es real, las notas hay que completarlas); columnas Paciente, cama, Médico, Pendientes; total en cuentas abiertas.
- **Registrar un ingreso**: **Nuevo ingreso** → Paciente («¿No tiene ficha? Crear paciente →»), Tipo de ingreso (Hospitalización, Ambulatorio, Urgencias, Consulta), cama/recurso, Médico tratante, Fecha y hora de ingreso, Convenio («Particular · sin convenio»), Receptor fiscal, Diagnóstico de ingreso · CIE-10, Procedimiento · CIE-9-MC, Motivo de ingreso; en Urgencias **Triage · NOM-027** (se puede dejar vacío: admisión registra al paciente al llegar y el médico lo clasifica al valorar; queda «Sin triage · NOM-027» en el expediente y la alerta «Urgencias sin triage» en el panel hasta capturarlo); Valoración · NOM-026 (Clasificación ASA) → **Registrar ingreso**.
- Avisos: «Elige al paciente. Si no tiene ficha, créala primero.»,  paciente sin CURP ni motivo: el hub rechaza el ingreso (NOM-024) → «Completar la ficha →». Cirugía ambulatoria: alta dentro de 12 h con Aldrete ≥ 9.
- **Permisos**: página Expedientes + Leer expediente; ingresar requiere Documentar atención.

## Expediente del episodio (/episodios/:id)
- **Qué se ve**: nombre del paciente, folio, diagnóstico, estado, chips (ASA, reloj ambulatorio, «Sin triage · NOM-027»), últimos signos vitales, lista lateral **Pacientes de hoy**, y pestañas: **Notas**, **Signos**, **Indicaciones y aplicaciones**, **Documentos**, **Admisión**, **Plan**, **Hoja SINBA** (sólo hospitalización y ambulatorio), **Bitácora**, **Accesos**. Enlace **Ver cuenta →**.
- **Acciones del encabezado**: «Cambiar estado…» (Programado, En valoración, Preoperatorio, En quirófano, Postoperatorio, Hospitalizado, o «Cancelar ingreso…»), **Trasladar** (Cama destino, Motivo), **Editar diagnóstico**, **Intercambio ▾** (Resumen clínico (CDA), Resumen de egreso (CDA), Referencia (CDA)…).
- **Notas**: **Nueva nota** → Tipo (Historia clínica, Nota de ingreso, Nota de evolución, preoperatoria, preanestésica, postoperatoria, postanestésica, enfermería, Hoja de urgencias, Indicación, Interconsulta, Referencia/traslado, Procedimiento, Nota de egreso…), Autor, secciones; botón **Dictar** (y «Estructurar con IA»). Las notas son inmutables: para corregir se usa **Corregir** (crea una versión nueva que deja visible la anterior). Las notas médicas requieren médico vinculado y verificado. Cada nota tiene **Imprimir** (formato del hospital: encabezado, ficha del paciente con alergias, secciones, nombre, cédula y sello) y, para quien la escribió, **Firmar** (firma con el dedo o la pluma en pantalla; queda ligada al sello de la nota, una sola vez; la nota muestra «Firmada»). Sólo el autor firma su nota; una nota corregida no se firma, se firma la corrección. Si no se firma en pantalla, se imprime y se firma a mano sobre la línea.
- **Imprimir…** (selector arriba del expediente): **Hoja frontal** (ingreso, egreso, diagnósticos, médico tratante, motivo de alta) y **Hoja de internamiento** (paciente, domicilio, adulto responsable con parentesco y teléfono, descripción del ingreso, líneas de firma de admisión y del responsable). Se arman con lo capturado; no se escriben a mano. **Índice del expediente**: los documentos del expediente (hoja frontal, historia clínica, notas, consentimientos, lista de cirugía segura…) con Sí / No / N/A propuestos según lo que ya existe; un clic en una casilla la corrige antes de imprimir. N/A es sólo para lo que no corresponde a esa atención; si debía estar y falta, queda No.
- **Notas estructuradas**: varias secciones se capturan como tabla o rejilla en lugar de texto. **Historia clínica**: antecedentes patológicos, no patológicos y heredofamiliares con **Sí / No** y detalle («Marcar «No» en los que falten»), gineco-obstétricos por campo y exploración física por región; además Motivo de consulta y Ocupación. **Hoja de enfermería**: signos por hora y medicamentos ministrados en tabla (se proponen solos con las tomas de signos y las aplicaciones del episodio), soluciones IV, datos del ingreso, somatometría y ayuno, accesos y sondas (AVP, CVC, sondas), balance de líquidos con totales, oxigenoterapia, llenado capilar y glucemia capilar; en urgencias se imprime como «Hoja de enfermería de urgencias». **Nota preanestésica**: antecedentes de importancia (se traen de la historia clínica), vía aérea (Mallampati, apertura oral, dentadura), laboratorios, gabinete, Goldman y consentimiento firmado. **Interconsulta**: médico que solicita, fecha de solicitud, médico interconsultante, plan de estudios. **Egreso**: signos al egreso, «¿Reingreso por la misma afección en el año?» y factores de riesgo. Las notas que piden signos vitales traen la última toma escrita. Si una sección llegó como texto (nota vieja o dictado), «Capturar en la tabla» la pasa a la tabla sin perder el texto.
- **Signos**: **Registrar signos** → TA, FC, FR, temperatura, SpO₂, glucosa, dolor, Peso (kg), Talla (cm) (el IMC se calcula), Observación → **Registrar toma**.
- **Indicaciones y aplicaciones**: **Nueva indicación** (requiere PRESCRIBIR) y **Registrar aplicación** (requiere ADMINISTRAR) → Insumo, Lote (FEFO: primero el que caduca antes), cantidad, Nota, Contexto fiscal; si es controlado pide folio de receta y Médico que prescribe con cédula. Descuenta el lote y carga la cuenta. Avisos: «… no tiene existencia en farmacia.», «La cantidad debe ser mayor que cero.».
- **Documentos**: **Agregar documento**; por documento: Firmar, Ver / imprimir, Llenar/Editar, Subir firmado/Reemplazar archivo, Recibido, Firmado, Descargar. Los requeridos pendientes cuentan en la pestaña.
- **Documentos de imagenología** (Agregar documento): **Consentimiento de procedimiento en imagen** (biopsia percutánea, colocación o recambio de nefrostomía, discólisis; «Se autoriza para» Mi persona / Mi familiar; la persona autorizada se propone del adulto responsable), **Cuestionario de seguridad (imagen)** (18 preguntas Sí / No con detalle, creatinina, declaración del paciente y la verificación del técnico radiólogo: identificación corroborada, preparación verificada, apto para el estudio) y **Registro de procedimiento (imagen)** (tipo, sitio anatómico, método de guía, horas, anestesiólogo, control de insumos que se propone con lo aplicado en el episodio). Los consentimientos de cirugía, anestesia, procedimiento en imagen y el cuestionario se pueden firmar en papel (Imprimir → Subir firmado / Firmado) o con **Firmar en pantalla**: congela el texto con lo capturado y abre la firma (paciente o representante, testigos y médico; en el cuestionario, paciente y técnico radiólogo). Antes de la primera firma, **Editar (vuelve a borrador)** permite corregir. El tipo de anestesia se elige (Endovenosa, Por vaporización, Mixta, Regional, Local, Sedación). Los textos legales los puede sustituir el hospital en Configuración.
- **Referencia**: en «Nuevo ingreso» y en «Editar diagnóstico» se capturan **Médico que refiere** y **Hospital o unidad de referencia** (pacientes que manda un médico externo); el expediente muestra «Referido por …» y el cuestionario de imagen los propone.
- **Admisión**: **Preparar paquete** / Completar paquete de documentos de admisión (consentimientos, aviso, contrato…), con Firmar e Imprimir.
- **Plan**: compara la cuenta contra el plan de tratamiento si el episodio nació de uno.
- **Dar de alta (egreso)** — dos pasos:
  1. El médico pulsa **Autorizar alta** (sólo aparece con ALTA + Documentar atención + identidad médica verificada) → Motivo de egreso (Curación, Mejoría, Traslado a otra unidad, Defunción, Alta voluntaria, Fuga, Otro), Diagnóstico de egreso · CIE-10 (obligatorio), Procedimiento realizado · CIE-9-MC, escala de Aldrete si hubo anestesia (ambulatorio: obligatoria y ≥ 9), **Nota de egreso** e **Instrucciones de egreso** (obligatorias). Con IA se puede proponer el borrador. Casilla «El paciente sale ahora: firmar y registrar la salida en este paso» → **Firmar alta y registrar salida**.
  2. Si no salió en ese momento, aparece «Alta médica autorizada por … La salida del paciente sigue pendiente.» con **Registrar salida** (requiere ALTA) → **Registrar salida ahora**, o **Suspender alta** (con motivo).
  - Sin permiso de autorizar se ve: «Para registrar la salida, solicita primero la autorización médica de alta en este expediente.» Si el expediente cambió: «La autorización de alta venció o el expediente cambió. El médico debe revisar y autorizar nuevamente…».
  - Después del alta: **Registrar seguimiento** (fecha y nota).
- **Cancelar ingreso**: desde «Cambiar estado…» → motivo; el folio se conserva y la cama se libera.
- **Accesos**: quién ha leído el expediente (bitácora).

## caja — Caja (/caja)
- **Para qué**: registrar los cobros del día —efectivo, transferencia, tarjeta o cheque— a un episodio o a una factura, y ver el corte de caja.
- **Con o sin CFDI**: cada cobro dice si lleva factura propia. **Con CFDI** sin factura ligada queda «pendiente de facturar» en el corte. **Sin CFDI** va a un episodio y sus cargos pasan a la **factura global** a público en general. Sin CFDI NO es «no declarado»: el sistema lo suma solo a los ingresos e IVA del mes hasta que la global se timbre.
- **Tarjeta a mano**: basta la afiliación de la terminal y la autorización del voucher; marca, tipo y últimos cuatro son opcionales.
- **Corte**: total del día por forma de pago (efectivo en caja, lo demás en tránsito al banco), con CFDI / sin CFDI y lo pendiente de facturar.
- **Pasos**: **Escanear voucher** (cámara) → la app lee Importe, Fecha, Afiliación, Autorización, Tarjeta, Titular («Corregir lo leído» para ajustar) → «¿De quién es este cobro?»: elegir una factura propuesta o buscar «Buscar factura por folio o nombre» → **Registrar cobro**. Confirmación «Cobro registrado por $…» con «Escanear otro». **Cancelar** reinicia.
- Aviso: «Elige la factura y confirma el importe para poder guardar.»
- **Permisos**: página Caja + Operaciones financieras (FINANZAS_ESCRIBIR).
- **Relacionadas**: Facturación, Bancos (liquidaciones de la terminal), Cuentas.

## facturacion — Facturación (/facturacion)
- **Para qué**: revisar y timbrar prefacturas (borradores de CFDI), factura global, complementos de pago, cancelaciones y sustituciones. Visible también para quien ve Caja o Cuentas.
- **Qué se ve**: prefacturas pendientes (Receptor, Total estimado, Enviada) con **Editar**, **Enviar**, **Descartar**, **Timbrar**; tarjeta **Factura global a público en general**; **Complementos de pago (PPD)**; **Facturas timbradas** (con buscador, **Sustituir**, **Cancelar**).
- **Facturar (desde la cuenta del paciente)**: en /cuentas/:id → **Facturar la cuenta** → elegir cargos «Por facturar» (o «Elegir todo lo por facturar»; **Dividir** un cargo si se reparte) → «A quién se factura» (paciente, pagador u «Otra persona o empresa») → Método de pago, Forma de pago, Uso del CFDI, Observaciones → **Generar prefactura · $…**. Luego aquí: revisar → **Timbrar** → **Timbrar $…**. La prefactura no consume timbre.
- **Nueva prefactura** manual: receptor (o «Dar de alta un receptor nuevo»: RFC, Nombre o razón social, Régimen fiscal, Código postal fiscal), Método/Forma de pago, Uso del CFDI, conceptos (**Agregar concepto**), Observaciones, opcional «Sustituye al CFDI» → **Guardar prefactura**.
- **Factura global**: los cargos marcados «Sin factura individual → factura global» desde la cuenta se juntan aquí → **Armar prefactura global**.
- **Complemento de pago**: en facturas PPD con cobro, **Emitir complemento**.
- **Cancelar CFDI ante el SAT**: **Cancelar** → motivo; con motivo 01 primero se timbra el sustituto (**Sustituir**) y luego se cancela el anterior («Cancelar el anterior»).
- **Permisos**: página Facturación/Caja/Cuentas + Operaciones financieras para escribir.

## cuentas — Cuentas (/cuentas)
- **Para qué**: cuentas abiertas de pacientes y cartera.
- **Qué se ve**: vistas **Cuentas abiertas** (KPIs Cuentas abiertas, En cama, En cuentas, Con pendientes; columnas Paciente, Pagador, Día de estancia, Pendientes), **Por cobrar** y **Por pagar** (cartera por contacto con antigüedad hasta «Más de 90», Facturas, REP pendiente). Clic en una cuenta → /cuentas/:id; en cartera → perfil del contacto.
- **Permisos**: página Cuentas; escribir requiere Operaciones financieras.

## Cuenta del paciente (/cuentas/:id)
- **Qué se ve**: «Cuenta del paciente», folio, pagador, deducible, receptor; cargos agrupados por categoría (los de farmacia salen con su lote); chip «Conciliada con el expediente» o «cargos sin nota / notas sin cargo»; **Facturación** (estimación hospital por pagador y paciente; «Facturan los médicos»: honorarios con su propio RFC); **Depósitos**; **Conciliación expediente ↔ cuenta**; **Reparto entre pagadores** (aviso si rebasa el tope de autorización del convenio); **De la cama al libro contable** con «Siguiente paso».
- **Acciones**: **Agregar cargo** → Categoría, Servicio del tarifario, Descripción, Cantidad, Precio unitario (sin IVA), Médico si es honorario → **Cargar a la cuenta**. **Cancelar** un cargo (con motivo; no se borra). **Facturar la cuenta** (ver Facturación). **Registrar depósito** → Forma de pago, Referencia (efectivo va a caja, lo demás a bancos).
- Avisos: «Describe el cargo.», «Un honorario lleva médico: es su factura, no la del hospital.»
- **Permisos**: Operaciones financieras para cargos, depósitos y facturar.

## cotizaciones — Cotizaciones (/cotizaciones)
- **Para qué**: presupuestos con el tarifario del pagador que, al ingresar, se vuelven la cuenta.
- **Nueva cotización** → Paciente (con ficha o sólo el nombre), Pagador (tarifario o precio de lista), Vigencia hasta, Procedimiento, partidas (**Agregar partida**) → **Guardar cotización**.
- **Detalle**: **Descargar PDF**, **Marcar enviada**, **Marcar aceptada**, **Cancelar**, **Convertir en ingreso** (Tipo de ingreso, Médico tratante, Fecha de ingreso → **Convertir**; requiere paciente con ficha), **Ver expediente**.
- Estados: Borrador, Enviada, Aceptada, Convertida en ingreso, Vencida, Cancelada.

## convenios — Convenios y tarifario (/convenios)
- **Para qué**: aseguradoras/empresas que pagan cuentas y lista de precios.
- Pestañas **Convenios** y **Tarifario**.
- **Nuevo convenio** → Pagador, RFC al que se factura, Tabulador, Plazo de pago (días), Deducible, Coaseguro (%), Tope de autorización, Vigencia desde/hasta → **Registrar convenio**. Sin convenio, la cuenta es particular.
- **Nuevo servicio** → Clave, Categoría, Nombre, Unidad de cobro, Precio de lista (sin IVA), IVA, Clave SAT producto/servicio, Clave SAT unidad → **Agregar al tarifario**. El precio por pagador se captura en la tabla.
- **Buscar en el tarifario**: arriba de la tabla, buscador por clave o nombre («ENDOS011», «colonoscopia») y filtro por **grupo** de la lista del hospital (LC, PAT, ENDOS, TAC…). La tabla muestra hasta 300; busca para ver el resto.
- **Importar lista de precios** (pestaña Tarifario) → Archivo (Excel o CSV con columnas Clave, Descripción, Grupo, Lista de precio, Precio) → **Los precios van a**: «Precio de lista (particular)» o «Tabulador de» un convenio. Primero muestra la vista previa: cuántos nuevos, cuántos cambian de precio (antes → ahora), sin cambio, los que no vienen en la hoja y las filas con error. **Aplicar** lo hace; queda en la bitácora con los precios anteriores. Se cruza por clave: cuando cambian los precios se vuelve a subir la misma hoja y sólo se actualiza lo que cambió. Opcional: «Dar de baja los servicios que no vienen en la hoja». Los precios se toman sin IVA; lo nuevo se clasifica por su grupo (LC/PAT/TAC… → Estudio, ENDOS/QUI → Quirófano, HON → Honorario…) y se puede corregir con **Editar**.
- **Detalle (/convenios/:id)**: «Cómo se aplica», antigüedad de la cartera y pestañas Pacientes, Expedientes, Facturas.

## protocolos — Protocolos (/protocolos)
- **Para qué**: la «receta» de un procedimiento (partidas del tarifario, insumos, estancia, quirófano, honorarios sugeridos). De ellos nacen los planes de tratamiento.
- **Nuevo protocolo** → Clave, Tipo de episodio, Especialidad, Nombre, Estancia (noches), CIE-9-MC, CIE-10, Quirófano (minutos), Anestesia, Requiere anestesiólogo, honorarios sugeridos, partidas e insumos → **Registrar protocolo**. Editar sube la versión; **Dar de baja**. «Simular con convenio» calcula el precio.
- Facetas Activos / Todos.

## medicos — Médicos y honorarios (/medicos)
- Pestañas **Honorarios** (por mes: Eventos, Del mes, Por dispersar; «Del cobro a la dispersión») y **Directorio**.
- **Nuevo médico** → Nombre, Especialidad, Cédula profesional, Teléfono, CURP y nombre por partes (responsable SAEH), Proveedor en el hub (para dispersar honorarios) → **Registrar médico**. La cédula es necesaria para el libro de control de controlados; el perfil médico se vincula al usuario en Usuarios para poder firmar.

## farmacia — Farmacia y almacén (/farmacia)
- Vistas **Inventario** y **Libro de control**. Facetas Todos, Bajo mínimo, Por caducar, Controlados, Refrigeración, Sin existencia.
- **Recibir lote** → insumo, Lote, Caducidad, cantidad, Costo unitario → **Recibir**. **Nuevo insumo** → Clave, Categoría, Nombre, Presentación, Mínimo en existencia, Precio de venta, Sustancia activa, Registro sanitario, Grupo de control, Controlado, Cadena de frío → **Registrar**. Por insumo: **Editar**, **Ajuste** / «Ajuste / merma» (cantidad y motivo → **Registrar movimiento**) y kardex.
- Libro de control (grupos I–III): balance por sustancia y movimientos; **CSV** / **Exportar XLSX**.
- Los insumos también se derivan de los CFDIs de compra (Configuración → Derivar ahora). Las aplicaciones en piso descuentan el lote.

## compras — Compras (/compras)
- **Para qué**: CFDIs de egreso del mes (lo comprado, a quién y qué ya está en farmacia).
- Selector de mes, buscador «Buscar proveedor, folio, concepto…», KPIs Facturas, Importe, Pagado, Pendiente («ver por pagar con antigüedad →»). Por factura: **Conceptos**, **Ver CFDI**, **Recibir lote** (da de alta el lote en farmacia).

## requisiciones — Requisiciones (/requisiciones)
- **Para qué**: toda compra se pide aquí y la autoriza otra persona; la requisición autorizada es la orden de compra. Visible también para quien ve Compras o Tesorería.
- Facetas **Por autorizar**, **Mías**, **Autorizadas**, **Rechazadas**.
- **Nueva requisición** → Proveedor, Área que pide, Se necesita para, líneas («Del catálogo» para insumos de farmacia; Cantidad, Precio estimado; **+ Agregar línea**), Justificación → guardar: queda por autorizar.
- **Autorizar** / **Rechazar** (con motivo; requiere COMPRAS_AUTORIZAR, nunca la propia). **Editar** o **Corregir y reenviar**; **Cancelar**.
- Orden autorizada: **Recibir** (o recibir en Farmacia si es insumo), **Ligar factura**, **Autorizar pago** (PAGOS_AUTORIZAR, no quien pidió), **Retirar autorización**, **Ir a tesorería**.
- Errores: «No puedes autorizar tu propia requisición: la autoriza otra persona.», «No autorizas el pago de una compra que tú pediste: lo autoriza otra persona.»

## clientes — Clientes (/clientes)
- Directorio de receptores fiscales derivado de los CFDIs de ingreso, ordenado por lo facturado; buscador por nombre o RFC. Perfil (/contactos/:id): pestañas Como cliente / Como proveedor, Episodios, Por cobrar, Facturas, **Estado de cuenta**, **Imprimir**.

## proveedores — Proveedores (/proveedores)
- Directorio derivado de los CFDIs de egreso. **Padrón · datos de pago** (/proveedores/padron): **Nuevo proveedor** → RFC, Razón social, Régimen fiscal, Correo, CLABE, Banco, Titular, crédito y días → guardar. Sin CLABE no se ve la cuenta para pagarle.

## tesoreria — Tesorería (/tesoreria)
- **Para qué**: pagar sólo lo autorizado; el pago se hace en el banco y aquí se registra.
- KPIs Autorizado por pagar, Ya debió pagarse, Esperando autorización, Pagado sin conciliar. Facetas **Por pagar**, **Por autorizar pago**, **Pagado por conciliar**, **Flujo de efectivo**.
- **Registrar pago** → Fecha del pago, Referencia / folio SPEI (obligatoria), Comprobante opcional (máx. 5 MB) → **Registrar pago** (requiere TESORERIA_PAGAR; quien autorizó el pago no lo registra). **Autorizar pago** desde la faceta correspondiente.

## bancos — Bancos (/bancos)
- Saldos por cuenta al último corte, selector de mes, movimientos (Por revisar / Conciliados) y **Depósitos de la terminal** (**Registrar liquidación**). Las cuentas y estados de cuenta se cargan en ContabilidadOS → Bancos («Abrir Bancos en ContabilidadOS»). Escribir requiere Operaciones financieras.

## nomina — Nómina (/nomina)
- Pestañas **Costo**, **Timbrar nómina**, **Corridas**, **Empleados**, **Aguinaldo y PTU**.
- **Correr nómina**: Timbrar nómina → «Nueva corrida ordinaria» (periodo, empleados Todos/Ninguno) → **Crear y calcular (N)** → pasos Periodo, Incidencias, Percepciones, Cálculo, Timbrado, Dispersión → **Timbrar N recibo(s)** → «Confirmar — es el punto sin retorno». Incidencias: falta, incapacidad, horas extra, vacaciones, permiso sin goce, bono, comisión, descuento.
- **Nuevo empleado** (datos personales, NSS, salario, periodicidad, registro patronal…); al darlo de alta recuerda presentar el alta ante el IMSS (IDSE). **Dar de baja** en la ficha del empleado. Recibos se pueden cancelar ante el SAT para corregir.
- **Permisos**: página Nómina + Operaciones financieras.

## mantenimiento — Mantenimiento (/mantenimiento)
- Facetas Abiertos, Preventivos, Cerrados. **Nuevo ticket** → título (p. ej. «Aire acondicionado de Quirófano 1 no enfría»), descripción, área, equipo, prioridad (Baja, Media, Alta, Urgente), casilla Preventivo → **Levantar ticket**. Por ticket: **Asignar**, **En proceso**, **Cerrar** / «Cerrar con resolución».

## registros — Registro diario (/registros)
- «Registro diario de atención»: por **Fecha local**, lista de ingresos del día (folio → expediente) y «Actividad auxiliar registrada hoy»; Anterior/Siguiente. Requiere Leer expediente.

## cumplimiento — Cumplimiento y evidencia (/cumplimiento)
- Obligaciones sanitarias con estado; **Evidencia e historial** → Estado, Responsable, Evidencia, Vencimiento, Próxima revisión → **Registrar revisión**. Otro administrador debe verificar. Incluye «Bitácora RPBI y cambios de responsable sanitario» (**Registrar actividad**). No presenta trámites ante la autoridad. Sólo administradores.

## saeh — SINBA · Egresos (/saeh)
- Egresos hospitalarios del mes (hospitalización y cirugía ambulatoria) para la DGIS. ◀ ▶ por mes, Hojas pendientes / Completas · exportadas, errores por hoja (enlazan a la Hoja SINBA del expediente). **Ver JSON**, **Exportar TXT** (asigna folio SAEH; casilla para incluir incompletas).

## contabilidad — Contabilidad del hospital (/contabilidad)
- Pestañas **Mapa de cuentas** (**Guardar mapa**, Restablecer), **Mes** (◀ ▶, **Asentar mes**) y **Apertura** (**Subir balanza** → **Asentar apertura**). Interruptor «Activa: asienta» / «En pausa: sólo previsualiza»; en pausa no se asienta.

## estado-resultados — Estado de resultados (/estado-resultados)
- Vista Mes/Año y periodo; KPIs Ingresos, Utilidad bruta, Resultado; columnas Declarado / Derivado / Diferencia. «Preliminar» si el mes aún no se presenta al SAT. Sin contabilidad electrónica importada no muestra datos.

## balance — Balance general (/balance)
- Activo, pasivo y capital por periodo; indica si «la foto cuadra». «Preliminar» o «Sólo lo declarado» según el periodo.

## impuestos — Impuestos (/impuestos)
- Declaración del mes con fecha límite (o «vencida hace N días»). Vistas **Resumen**, **Papeles de trabajo** (IVA, ISR provisional, Retenciones) y **Revisión**. KPIs IVA del periodo, ISR provisional, Retenciones a enterar, ISR retenido a médicos, Total al SAT. Excluye CFDIs de proveedores 69-B (EFOS).

## La mascota de ayuda (Cubo, Mochi o Lupa)
- Es el botón con el personaje en la esquina inferior derecha de cualquier pantalla (en el teléfono, arriba de la barra inferior). Al tocarlo se abre la ayuda: preguntas sugeridas para la pantalla actual y un campo para escribir cualquier pregunta sobre cómo usar HospitalOS.
- La mascota se puede arrastrar a cualquier lugar de la pantalla. Si se suelta encima de una tarjeta, un indicador (KPI), una tabla o una sección, la resalta y explica en una burbuja qué es y para qué sirve; «Preguntar más» abre el chat con esa explicación. Un toque sin arrastrar abre o cierra la ayuda. «Regresar a la esquina» (en el engrane) la devuelve a su lugar.
- Las respuestas pueden traer botones para abrir la página indicada. Debajo de cada respuesta están 👍 («Me sirvió») y 👎 («No me sirvió»); con 👎 se puede escribir qué esperaba. Esas valoraciones las ve el administrador para mejorar la ayuda y el software.
- En el engrane del panel de ayuda se elige el personaje (Cubo, Mochi o Lupa), su color y un nombre propio, y se puede ocultar la mascota. Para volver a mostrarla: Configuración → «Mostrar la mascota de ayuda».
- No hace falta escribir datos de pacientes para pedir ayuda. La mascota no consulta ni modifica información del hospital: sólo explica cómo usar el sistema.

## preguntas — Preguntas a la mascota (/preguntas)
- Sólo dueño o administrador. Está en el pie del riel (y en «Más» del teléfono), junto a Usuarios.
- Muestra lo que el personal le pregunta a la mascota en los últimos 7, 30 o 90 días: totales, cuántas respuestas sirvieron y cuántas no, preguntas sin respuesta en la guía, las páginas donde más se pregunta y las preguntas repetidas (candidatas a preguntas frecuentes).
- Filtros: «Todas», «Sin respuesta», «No sirvieron». Cada renglón trae quién preguntó, en qué página, la pregunta, la respuesta y el comentario si dejó uno.
`;
