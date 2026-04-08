/**
 * Seed Hacienda Ovinos de Ajuluapan into CONSTRUCTORA BARTIZ-VERT (CBA170606FQ8).
 *
 * Imports real data from the partner's two presupuestos (Básico + Integral)
 * so Juan can use the software for the meeting where the customer chooses
 * between both options.
 *
 * What this creates (idempotent — safe to re-run):
 *   1. ~38 Conceptos in the company catalog, each with a minimal v1 APU
 *      (flat precioUnitario, no insumo breakdown yet)
 *   2. 1 Proyecto: "Rehabilitación Hacienda Ovinos de Ajuluapan"
 *   3. 2 Presupuestos attached to the proyecto:
 *      - v1: "Mantenimiento Básico"      → $1,891,217.07 (sin IVA)
 *      - v2: "Rehabilitación Integral"   → $3,276,354.85 (sin IVA)
 *      Both start in BORRADOR. After the meeting, flip one to APROBADO and
 *      the other to RECHAZADO.
 *   4. All presupuesto partidas with zona + partida hierarchy matching the
 *      PDF layout (HACIENDA → PLANTA BAJA / PLANTA ALTA / PASILLO / AZOTEA /
 *      FACHADA → A1 PRELIMINARES / A2 MURO / ... → conceptos)
 *
 * The IMP003 code collision in the source PDFs (same code used for azotea
 * and muro applications of the same hidrofugante product) is resolved by
 * splitting into two conceptos:
 *   - IMP003-AZOTEA: impermeabilización en azotea
 *   - IMP003-MURO:   impermeabilización en muro
 *
 * Run:
 *   set -a; . ./.env.local; set +a
 *   node scripts/seed-hacienda-ovinos.mjs
 *
 * Re-run safety: uses upsert on conceptos (by companyId+codigo) and on the
 * proyecto (by companyId+codigo=OBR-HACIENDA-OVINOS). Presupuestos and their
 * partidas are always wiped and recreated to match the source PDFs exactly.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const COMPANY_RFC = "CBA170606FQ8";
const PROYECTO_CODIGO = "OBR-HACIENDA-OVINOS";
const PROYECTO_NOMBRE = "Rehabilitación Hacienda Ovinos de Ajuluapan";
const PROYECTO_UBICACION = "Puebla";

// ─── CONCEPTOS ───────────────────────────────────────────────────────────────
// Master catalog for these budgets. Flat PU only (no insumo breakdowns yet).
// Category is inferred from what partidas the concepto belongs to in the PDFs.

const CONCEPTOS = [
  // PRELIMINARES / DEMOLICIONES
  { codigo: "HERB01",       unidad: "lote", precio: 3148.03, categoria: "Preliminares",
    descripcion: "APLICACIÓN LOCALIZADA DE HERBICIDA SISTÉMICO NO EXPANSIVO PARA ELIMINACIÓN TOTAL DE RAÍCES RESIDUALES EN GRIETAS Y POROS DE LA LOSA/BÓVEDA, EVITANDO REBROTES FUTUROS Y SIN AFECTAR EL CONCRETO NI LOS MORTEROS COMPATIBLES. INCLUYE: APLICACIÓN DIRIGIDA EN PUNTOS DE CRECIMIENTO, PROTECCIÓN DE SUPERFICIES ADYACENTES, MATERIALES, MANO DE OBRA, EQUIPO Y HERRAMIENTAS." },
  { codigo: "APUN001",      unidad: "m2",   precio: 338.49,  categoria: "Preliminares",
    descripcion: "SUMINISTRO Y COLOCACIÓN DE APUNTALAMIENTO PREVENTIVO PARA LOSAS/MUROS EXISTENTES, MEDIANTE PUNTALES METÁLICOS O DE MADERA, INCLUYENDO NIVELACIÓN, AJUSTE Y RETIRO POSTERIOR, GARANTIZANDO LA SEGURIDAD DURANTE LOS TRABAJOS DE REHABILITACIÓN." },
  { codigo: "DEM035",       unidad: "m2",   precio: 81.02,   categoria: "Demoliciones",
    descripcion: "DEMOLICIÓN A MANO DE APLANADOS DE MEZCLA EN MUROS" },
  { codigo: "DEM002",       unidad: "m2",   precio: 308.61,  categoria: "Demoliciones",
    descripcion: "DEMOLICIÓN A MANO DE MURO DE ADOBE DE 60 CENTÍMETROS DE ESPESOR" },
  { codigo: "DEM029",       unidad: "m2",   precio: 92.58,   categoria: "Demoliciones",
    descripcion: "DEMOLICIÓN A MANO DE PISOS DE MOSAICO O LOSETA DE BARRO INCLUYE MORTERO" },

  // EXCAVACIONES Y CIMENTACIÓN
  { codigo: "EXCA001",      unidad: "m3",   precio: 315.04,  categoria: "Excavaciones",
    descripcion: "EXCAVACIÓN A MANO EN ZANJA, INCLUYE AFINE DE TALUDES Y FONDO. MATERIAL COMÚN SECO, CUALQUIER ZONA, PROFUNDIDAD DE 0.00 A 2.00 M" },
  { codigo: "ECXV01",       unidad: "m3",   precio: 315.04,  categoria: "Excavaciones",
    descripcion: "EXCAVACIÓN PERIMETRAL MANUAL DE TIERRA VEGETAL HASTA DESCUBRIR EL MURO DE CIMENTACIÓN, RETIRO DE TIERRA Y LIMPIEZA DEL ÁREA" },
  { codigo: "GRAVARENA",    unidad: "m3",   precio: 712.61,  categoria: "Cimentación",
    descripcion: "SUMINISTRO Y COLOCACIÓN DE GRAVA-ARENA MEJORADA CON 4% DE CEMENTO CON RELACIÓN A SU PVSM MEDIDO COMPACTO COMO TERRAPLÉN ADICIONAL. EN ÁREA DE FIRME O PAVIMENTACIÓN EN VIALIDAD, AUTORIZADO PREVIAMENTE." },
  { codigo: "CIM-LOS001",   unidad: "m2",   precio: 383.66,  categoria: "Cimentación",
    descripcion: "SUMINISTRO Y EJECUCIÓN DE LOSA DE PISO A BASE DE CAL HIDRÁULICA NATURAL. INCLUYE: CAPA DE ASIENTO DE ARENA; COLADO DE LOSA DE CAL HIDRÁULICA NATURAL DE 8 CM DE ESPESOR, CON DOSIFICACIÓN ADECUADA, PERFECTAMENTE NIVELADA Y AFINADA; CURADO HÚMEDO CONFORME A ESPECIFICACIONES TÉCNICAS, MANO DE OBRA, EQUIPO Y HERRAMIENTA." },
  { codigo: "IMP001",       unidad: "m2",   precio: 329.90,  categoria: "Impermeabilización",
    descripcion: "IMPERMEABILIZACIÓN EN CIMENTACIÓN, DALAS Y CONTRA TRABES CON MICROLASTIC O SIMILAR" },

  // MUROS
  { codigo: "REPMURO",      unidad: "m2",   precio: 1449.64, categoria: "Muros",
    descripcion: "REPARACIÓN EN MUROS DE ADOBE INCLUYE: PREPARACIÓN DE LA SUPERFICIE (RETIRO DE MAT. SUELTO), MALLA, APLANADO FINO CON MORTERO CEMENTO-CAL-ARENA: 1:1:3 CON ESP. PROMEDIO DE 3 CENTÍMETROS" },
  { codigo: "EST001",       unidad: "kg",   precio: 66.32,   categoria: "Estructura",
    descripcion: "SUMINISTRO, HABILITADO E INSTALACIÓN DE PERFIL MONTEN ASTM A-36. EN REMPLAZO DE LA VIGA EN VANO DE VENTANA O PUERTA EXISTENTE, INCLUYE: RETIRO CUIDADOSO DE VIGA EXISTENTE, MATERIALES, MANO DE OBRA, EQUIPO Y HERRAMIENTA." },
  { codigo: "IMP002",       unidad: "m",    precio: 465.64,  categoria: "Impermeabilización",
    descripcion: "SUMINISTRO Y APLICACIÓN DE BARRERA QUÍMICA ANTIHUMEDAD POR CAPILARIDAD, MEDIANTE PERFORACIONES HORIZONTALES EN LA BASE DEL MURO Y POSTERIOR INYECCIÓN DE PRODUCTO A BASE DE SILANOS/SILOXANOS O EQUIVALENTE, FORMANDO UNA BARRERA CONTINUA QUE IMPIDE EL ASCENSO DE HUMEDAD DESDE EL SUELO. INCLUYE PERFORACIONES, INYECCIÓN DEL PRODUCTO, SELLADO DE PERFOROS CON MORTERO COMPATIBLE, MATERIALES, MANO DE OBRA, EQUIPO Y HERRAMIENTA." },
  { codigo: "GRI-MOR01",    unidad: "m",    precio: 291.39,  categoria: "Muros",
    descripcion: "COSIDO DE GRIETAS Y FISURAS EN MUROS AFECTADOS POR HUMEDAD, MEDIANTE COLOCACIÓN DE ANCLAJES O VARILLA Y RESANE CON MORTERO COMPATIBLE A BASE DE CAL, RESTITUYENDO LA CONTINUIDAD DEL MURO Y EVITANDO FILTRACIONES FUTURAS; INCLUYE MATERIALES, MANO DE OBRA Y LIMPIEZA." },
  { codigo: "GRI-MOR02",    unidad: "m2",   precio: 265.82,  categoria: "Muros",
    descripcion: "REPARACIÓN DE GRIETAS EXISTENTES EN MUROS Y LOSA/BÓVEDA, MEDIANTE APERTURA CONTROLADA, LIMPIEZA Y RESANE CON MORTERO COMPATIBLE A BASE DE CAL HIDRÁULICA O MORTERO CEMENTICIO FLEXIBLE TRANSPIRABLE, SIN EMPLEO DE COSIDO METÁLICO, PERMITIENDO LA CORRECTA ADHERENCIA, FLEXIBILIDAD Y COMPATIBILIDAD CON EL SISTEMA CONSTRUCTIVO EXISTENTE." },
  { codigo: "REPETALO",     unidad: "m2",   precio: 403.99,  categoria: "Muros",
    descripcion: "REPELLADO EN MUROS INTERIORES/EXTERIORES EN MUROS TRATADOS CONTRA HUMEDAD, CON MEZCLA CAL VIVA APAGADA-ARENA EN PROPORCIÓN 1:3 DE 2 CENTÍMETROS DE ESPESOR PROMEDIO INCL, ANDAMIOS, MATERIALES, MANO DE OBRA, EQUIPO Y HERRAMIENTAS." },
  { codigo: "PINTM010",     unidad: "m2",   precio: 194.30,  categoria: "Acabados",
    descripcion: "SUMINISTRO Y APLICACIÓN DE PINTURA MINERAL SOBRE MUROS Y PLAFONES QUE PERMITE LA EVAPORACIÓN DEL VAPOR DE AGUA Y PROTEGE EL APLANADO SIN SELLAR EL PARAMENTO. INCLUYE: PREPARACIÓN DE LA SUPERFICIE, ANDAMIOS, PROTECCIÓN DE PISOS Y MUROS, UNA MANO DE SELLADOR Y DOS MANOS DE PINTURA." },

  // PISOS
  { codigo: "BARRO001",     unidad: "m2",   precio: 763.08,  categoria: "Pisos",
    descripcion: "PISO DE LOSETA DE BARRO LÍNEA ECONÓMICA DE 30X30 CM. ASENTADA CON PEGAZULEJO Y JUNTA DE COLOR DE ACUERDO AL MODELO, INCLUYE: SUMINISTRO DE MATERIALES, MANO DE OBRA, EQUIPO Y HERRAMIENTA." },
  { codigo: "REPPISO",      unidad: "m2",   precio: 763.08,  categoria: "Pisos",
    descripcion: "REPARACIÓN EN PISO DE LADRILLO DE BARRO INCLUYE: RETIRO DE PIEZAS AFECTADAS, PREPARACIÓN DE LA SUPERFICIE PARA RECIBIR PIEZAS NUEVAS Y TODO LO NECESARIO PARA SU CORRECTA COLOCACIÓN" },

  // LOSAS / TECHOS
  { codigo: "VIGMA001",     unidad: "m2",   precio: 133.50,  categoria: "Losas",
    descripcion: "SUMINISTRO Y APLICACIÓN DE TRATAMIENTO PREVENTIVO Y CORRECTIVO EN ELEMENTOS ESTRUCTURALES DE MADERA, A BASE DE SALES DE BORO O PRODUCTO EQUIVALENTE, MEDIANTE BROCHA O ASPERSIÓN, PROTEGIENDO CONTRA HONGOS, TERMITAS Y XILÓFAGOS, SIN SELLAR LA MADERA Y PERMITIENDO SU TRANSPIRACIÓN. INCLUYE: MATERIALES, MANO DE OBRA, EQUIPO Y HERRAMIENTA. APLICACIÓN INDEPENDIENTE POR ÁREA CONFORME A LA SECUENCIA DE OBRA." },
  { codigo: "VIGMA002",     unidad: "m",    precio: 201.91,  categoria: "Losas",
    descripcion: "REFORZAMIENTO ESTRUCTURAL DE VIGAS DE MADERA DETERIORADAS MEDIANTE COLOCACIÓN DE ELEMENTOS DE REFUERZO (MADERA NUEVA TIPO 'VIGA HERMANA' O PLACAS METÁLICAS ATORNILLADAS), GARANTIZANDO LA RECUPERACIÓN DE LA CAPACIDAD PORTANTE SIN ALTERAR EL SISTEMA CONSTRUCTIVO ORIGINAL." },
  { codigo: "REPTECHO",     unidad: "m2",   precio: 306.64,  categoria: "Losas",
    descripcion: "REPARACIÓN EN TECHO CATALÁN INCLUYE: PREPARACIÓN DE LA SUPERFICIE (RETIRO DE MAT. SUELTO), PARA RECIBIR TRATAMIENTO EN VIGAS DE MADERA Y LOSETA DE BARRO A BASE DE ESMALTE O BARNIZ" },
  { codigo: "LOSATEJ",      unidad: "m2",   precio: 1145.12, categoria: "Cubiertas",
    descripcion: "SUMINISTRO Y COLOCACIÓN DE TEJA EN CUBIERTA, INCLUYENDO RETIRO DE TEJA EXISTENTE, LIMPIEZA DEL ÁREA, SELECCIÓN Y REPOSICIÓN DE PIEZAS DAÑADAS, COLOCACIÓN DE TEJA NUEVA Y/O RECUPERADA, ALINEACIÓN, FIJACIÓN Y AJUSTE CONFORME AL SISTEMA CONSTRUCTIVO EXISTENTE. LOS TRABAJOS INCLUYEN MATERIALES, MANO DE OBRA, HERRAMIENTA, EQUIPO, ACARREO, DESPERDICIOS." },

  // IMPERMEABILIZACIÓN
  { codigo: "IMP008",       unidad: "m2",   precio: 52.50,   categoria: "Impermeabilización",
    descripcion: "RETIRO O LEVANTAMIENTO DE IMPERMEABILIZANTE DETERIORADO O EN MAL ESTADO EN ÁREA DE AZOTEA" },
  { codigo: "IMP003-AZOTEA", unidad: "m2",  precio: 343.61,  categoria: "Impermeabilización",
    descripcion: "IMPERMEABILIZACIÓN EN AZOTEA CON HIDROFUGANTE MINERAL TRANSPIRABLE A BASE DE SILANO–SILOXANO (PASA SIL A – REPELENTE DE AGUA INCOLORO 19L (BASE AGUA)) O SIMILAR, PERMITIENDO LA PROTECCIÓN CONTRA FILTRACIONES DE AGUA PLUVIAL SIN IMPEDIR LA EVACUACIÓN DE VAPOR, COMPATIBLE CON SISTEMAS CONSTRUCTIVOS TRADICIONALES. APLICACIÓN INDEPENDIENTE POR ÁREA CONFORME A LA SECUENCIA DE OBRA." },
  { codigo: "IMP003-MURO",  unidad: "m2",   precio: 343.61,  categoria: "Impermeabilización",
    descripcion: "IMPERMEABILIZACIÓN EN MURO CON HIDROFUGANTE MINERAL TRANSPIRABLE A BASE DE SILANO–SILOXANO (PASA SIL A – REPELENTE DE AGUA INCOLORO 19L (BASE AGUA)) O SIMILAR, PERMITIENDO LA PROTECCIÓN CONTRA FILTRACIONES DE AGUA PLUVIAL SIN IMPEDIR LA EVACUACIÓN DE VAPOR, COMPATIBLE CON SISTEMAS CONSTRUCTIVOS TRADICIONALES. APLICACIÓN INDEPENDIENTE POR ÁREA CONFORME A LA SECUENCIA DE OBRA." },
  { codigo: "IMP004",       unidad: "m2",   precio: 761.06,  categoria: "Impermeabilización",
    descripcion: "IMPERMEABILIZACIÓN DE AZOTEA MEDIANTE LA APLICACIÓN DE RECUBRIMIENTO CEMENTICIO FLEXIBLE IMPERMEABLE SIKATOP® SEAL-107 O SIMILAR, APLICADO EN DOS CAPAS CRUZADAS, SOBRE SUPERFICIE PREVIAMENTE PREPARADA, LIMPIA Y LIBRE DE POLVO, GRASAS O MATERIALES SUELTOS. INCLUYE MATERIALES, MANO DE OBRA, EQUIPO Y HERRAMIENTAS. APLICACIÓN INDEPENDIENTE POR ÁREA CONFORME A LA SECUENCIA DE OBRA." },

  // HERRERÍA
  { codigo: "VEHE001",      unidad: "pza",  precio: 3219.52, categoria: "Herrería",
    descripcion: "SUMINISTRO Y COLOCACIÓN, VENTANA DE HERRERÍA CON PERFILES TUBULARES DE 1 1/2\" X 1 1/2\" CALIBRE 18 DE 0.50 M X 0.60 METROS INCLUYE: SUMINISTRO Y COLOCACIÓN DE CRISTAL DE 4 MM." },
  { codigo: "VENT001",      unidad: "pza",  precio: 4661.68, categoria: "Herrería",
    descripcion: "SUMINISTRO Y COLOCACIÓN DE VENTANA DE COCINA" },
  { codigo: "ESCMET001",    unidad: "pza",  precio: 12190.37, categoria: "Herrería",
    descripcion: "SUMINISTRO Y COLOCACIÓN DE ESCALERA METÁLICA DE APROXIMADAMENTE 8 ESCALONES, FABRICADA CON PERFILES DE ACERO ESTRUCTURAL, DISEÑADA CONFORME A DIMENSIONES Y PENDIENTES REQUERIDAS EN OBRA. INCLUYE HUELLAS Y CONTRAHUELLAS METÁLICAS, ESTRUCTURA PORTANTE, ANCLAJE A LOSA, SOLDADURA, NIVELACIÓN, LIMPIEZA, APLICACIÓN DE PRIMARIO ANTICORROSIVO Y ACABADO CON PINTURA ESMALTE, ASÍ COMO MATERIALES, MANO DE OBRA, HERRAMIENTA, EQUIPO." },
  { codigo: "ESCM004",      unidad: "pza",  precio: 4901.01, categoria: "Herrería",
    descripcion: "ESCALERA MARINA A BASE DE ESCALONES DE VARILLA DE 1\" DE DIÁMETRO, CON UNA SECCIÓN DE 0.30 X 0.60 METROS (CON 3 ESCALONES)." },
  { codigo: "CAN-PLUV01",   unidad: "m",    precio: 386.26,  categoria: "Herrería",
    descripcion: "SUMINISTRO Y COLOCACIÓN DE CANALETA GALVANIZADA, CON SECCIÓN DE 12\" X 8\", INCLUYENDO BAJANTE DE DESCARGA, FABRICADA Y COLOCADA CONFORME A PROYECTO. LOS TRABAJOS INCLUYEN TRAZO, NIVELACIÓN, FIJACIÓN MEDIANTE ANCLAJES Y SOPORTES METÁLICOS, SELLADO DE JUNTAS, CORTES, EMPALMES, PRUEBAS DE ESCURRIMIENTO Y AJUSTE FINAL PARA GARANTIZAR EL CORRECTO DESALOJO DE AGUAS PLUVIALES. INCLUYE MATERIALES, MANO DE OBRA, HERRAMIENTA, EQUIPO Y TODO LO NECESARIO PARA SU CORRECTA INSTALACIÓN Y FUNCIONAMIENTO." },

  // CARPINTERÍA
  { codigo: "REPCARP",      unidad: "m2",   precio: 278.00,  categoria: "Carpintería",
    descripcion: "REHABILITACIÓN DE PUERTAS Y VENTANAS DE MADERA INCLUYE: PREPARACIÓN DE LA SUPERFICIE, RESANE, DOS MANOS DE BARNIZ Y TINTA" },

  // INSTALACIONES
  { codigo: "INSREG01",     unidad: "pza",  precio: 3312.21, categoria: "Instalaciones",
    descripcion: "REPARACIÓN INTEGRAL DE REGADERA EN BAÑO EXISTENTE, QUE INCLUYE CAMBIO DE MEZCLADORA, BRAZO Y CHAPETÓN DE REGADERA, SUSTITUCIÓN DE VÁLVULAS DAÑADAS Y/O TRAMOS DE TUBERÍA HIDRÁULICA (CPVC, COBRE O PEX SEGÚN INSTALACIÓN EXISTENTE), CORRECCIÓN DE FUGAS, SELLOS Y CONEXIONES. INCLUYE DESMONTAJE DE PIEZAS EXISTENTES, SUMINISTRO Y COLOCACIÓN DE MATERIALES, MANO DE OBRA ESPECIALIZADA, HERRAMIENTA, PRUEBAS DE FUNCIONAMIENTO, AJUSTES FINALES Y LIMPIEZA DEL ÁREA DE TRABAJO." },
  { codigo: "TIN-DES",      unidad: "pza",  precio: 1337.02, categoria: "Instalaciones",
    descripcion: "RETIRO CONTROLADO DE TINACO EXISTENTE FABRICADO CON ASBESTO, INCLUYENDO VACIADO PREVIO, DESCONEXIÓN DE TUBERÍAS, DESMONTAJE MANUAL SIN FRAGMENTAR LA PIEZA, MANEJO Y EMBALAJE CONFORME A PROTOCOLOS DE SEGURIDAD, CARGA, ACARREO Y DISPOSICIÓN FINAL EN SITIO AUTORIZADO. INCLUYE EQUIPO DE PROTECCIÓN PERSONAL, MANO DE OBRA ESPECIALIZADA, HERRAMIENTA, EQUIPO, LIMPIEZA DEL ÁREA INTERVENIDA Y TODO LO NECESARIO PARA SU CORRECTA EJECUCIÓN." },
  { codigo: "PLUV001",      unidad: "lote", precio: 7042.74, categoria: "Instalaciones",
    descripcion: "REPARACIÓN DE BAJADAS PLUVIALES. DESAZOLVE Y LIMPIEZA, INCLUYE: RETIRO DE MATERIAL, IMPERMEABILIZACIÓN, MATERIALES, MANO DE OBRA, HERRAMIENTA Y TODO LO NECESARIO PARA SU CORRECTA EJECUCIÓN" },

  // LIMPIEZA
  { codigo: "LIM001",       unidad: "m2",   precio: 111.61,  categoria: "Limpieza",
    descripcion: "LIMPIEZA MANUAL DE MUROS Y CARA INFERIOR DE LOSA EXISTENTES AFECTADOS POR HUMEDAD, EFLORESCENCIAS (SALITRE), MANCHAS Y SUCIEDAD SUPERFICIAL, MEDIANTE PROCEDIMIENTOS NO AGRESIVOS, CON EL FIN DE ELIMINAR CONTAMINANTES VISIBLES Y PREPARAR LAS SUPERFICIES PARA TRABAJOS POSTERIORES DE SECADO, TRATAMIENTO Y RESTAURACIÓN, SIN DAÑAR LOS MATERIALES ORIGINALES." },
  { codigo: "LIM005",       unidad: "m2",   precio: 89.01,   categoria: "Limpieza",
    descripcion: "LIMPIEZA GENERAL DURANTE LA OBRA INCLUYE ACARREOS DE ESCOMBROS, ETC." },
];

// ─── PRESUPUESTO BÁSICO partidas ────────────────────────────────────────────
// Each row = { zona, partida, codigo, cantidad }. PU is looked up from CONCEPTOS.

const PARTIDAS_BASICO = [
  // PLANTA BAJA / A1 PRELIMINARES
  { zona: "PLANTA BAJA", partida: "A1 PRELIMINARES", codigo: "HERB01",    cantidad: 1 },
  { zona: "PLANTA BAJA", partida: "A1 PRELIMINARES", codigo: "APUN001",   cantidad: 31 },
  { zona: "PLANTA BAJA", partida: "A1 PRELIMINARES", codigo: "DEM035",    cantidad: 72.97 },
  { zona: "PLANTA BAJA", partida: "A1 PRELIMINARES", codigo: "DEM002",    cantidad: 13.02 },
  { zona: "PLANTA BAJA", partida: "A1 PRELIMINARES", codigo: "DEM029",    cantidad: 31 },

  // PLANTA BAJA / A2 MURO
  { zona: "PLANTA BAJA", partida: "A2 MURO", codigo: "REPMURO",    cantidad: 17.22 },
  { zona: "PLANTA BAJA", partida: "A2 MURO", codigo: "EST001",     cantidad: 103.48 },
  { zona: "PLANTA BAJA", partida: "A2 MURO", codigo: "BARRO001",   cantidad: 31 },
  { zona: "PLANTA BAJA", partida: "A2 MURO", codigo: "GRI-MOR02",  cantidad: 35.82 },
  { zona: "PLANTA BAJA", partida: "A2 MURO", codigo: "REPETALO",   cantidad: 230.21 },
  { zona: "PLANTA BAJA", partida: "A2 MURO", codigo: "PINTM010",   cantidad: 598.81 },

  // PLANTA BAJA / A3 LOSA
  { zona: "PLANTA BAJA", partida: "A3 LOSA", codigo: "VIGMA001",   cantidad: 94.56 },
  { zona: "PLANTA BAJA", partida: "A3 LOSA", codigo: "VIGMA002",   cantidad: 10.5 },
  { zona: "PLANTA BAJA", partida: "A3 LOSA", codigo: "REPTECHO",   cantidad: 55.02 },

  // PLANTA BAJA / A4 IMPERMEABILIZACIÓN
  { zona: "PLANTA BAJA", partida: "A4 IMPERMEABILIZACIÓN", codigo: "IMP004", cantidad: 12.9 },

  // PLANTA BAJA / A5 HERRERÍA
  { zona: "PLANTA BAJA", partida: "A5 HERRERÍA", codigo: "VEHE001", cantidad: 2 },

  // PLANTA BAJA / A6 CARPINTERÍA
  { zona: "PLANTA BAJA", partida: "A6 CARPINTERÍA", codigo: "REPCARP", cantidad: 28.14 },

  // PLANTA BAJA / A7 LIMPIEZA
  { zona: "PLANTA BAJA", partida: "A7 LIMPIEZA", codigo: "LIM001", cantidad: 840.55 },
  { zona: "PLANTA BAJA", partida: "A7 LIMPIEZA", codigo: "LIM005", cantidad: 188.76 },

  // PLANTA ALTA / C1 LOSA
  { zona: "PLANTA ALTA", partida: "C1 LOSA", codigo: "VIGMA001",  cantidad: 119.56 },
  { zona: "PLANTA ALTA", partida: "C1 LOSA", codigo: "REPTECHO",  cantidad: 113.44 },
  { zona: "PLANTA ALTA", partida: "C1 LOSA", codigo: "GRI-MOR02", cantidad: 29.02 },

  // PLANTA ALTA / C2 MUROS
  { zona: "PLANTA ALTA", partida: "C2 MUROS", codigo: "REPETALO", cantidad: 158.57 },
  { zona: "PLANTA ALTA", partida: "C2 MUROS", codigo: "PINTM010", cantidad: 444.16 },

  // PLANTA ALTA / C3 PISO
  { zona: "PLANTA ALTA", partida: "C3 PISO", codigo: "VIGMA001", cantidad: 29.48 },

  // PLANTA ALTA / C4 HERRERÍA
  { zona: "PLANTA ALTA", partida: "C4 HERRERÍA", codigo: "VENT001", cantidad: 1 },

  // PLANTA ALTA / C5 CARPINTERÍA
  { zona: "PLANTA ALTA", partida: "C5 CARPINTERÍA", codigo: "REPCARP", cantidad: 28.35 },

  // PLANTA ALTA / C6 INSTALACIÓN
  { zona: "PLANTA ALTA", partida: "C6 INSTALACIÓN", codigo: "INSREG01", cantidad: 1 },

  // PLANTA ALTA / C7 LIMPIEZA
  { zona: "PLANTA ALTA", partida: "C7 LIMPIEZA", codigo: "LIM001", cantidad: 840.17 },
  { zona: "PLANTA ALTA", partida: "C7 LIMPIEZA", codigo: "LIM005", cantidad: 218.35 },

  // PASILLO / B1 PISO
  { zona: "PASILLO", partida: "B1 PISO", codigo: "REPPISO", cantidad: 125.27 },

  // PASILLO / B2 LOSA
  { zona: "PASILLO", partida: "B2 LOSA", codigo: "VIGMA001", cantidad: 62.04 },
  { zona: "PASILLO", partida: "B2 LOSA", codigo: "REPTECHO", cantidad: 139.59 },
  { zona: "PASILLO", partida: "B2 LOSA", codigo: "LOSATEJ",  cantidad: 139.59 },

  // AZOTEA / D1 LOSA
  { zona: "AZOTEA", partida: "D1 LOSA", codigo: "IMP008",    cantidad: 432.31 },
  { zona: "AZOTEA", partida: "D1 LOSA", codigo: "GRI-MOR02", cantidad: 281 },

  // AZOTEA / D2 IMPERMEABILIZANTE
  { zona: "AZOTEA", partida: "D2 IMPERMEABILIZANTE", codigo: "IMP004", cantidad: 432.31 },

  // AZOTEA / D3 HERRERÍA
  { zona: "AZOTEA", partida: "D3 HERRERÍA", codigo: "ESCMET001", cantidad: 1 },
  { zona: "AZOTEA", partida: "D3 HERRERÍA", codigo: "ESCM004",   cantidad: 1 },

  // AZOTEA / D4 INSTALACIÓN
  { zona: "AZOTEA", partida: "D4 INSTALACIÓN", codigo: "TIN-DES", cantidad: 1 },
  { zona: "AZOTEA", partida: "D4 INSTALACIÓN", codigo: "PLUV001", cantidad: 1 },

  // FACHADA / E1
  { zona: "FACHADA", partida: "E1 FACHADA", codigo: "APUN001",    cantidad: 54.56 },
  { zona: "FACHADA", partida: "E1 FACHADA", codigo: "GRI-MOR01",  cantidad: 18.19 },
  { zona: "FACHADA", partida: "E1 FACHADA", codigo: "GRI-MOR02",  cantidad: 464.49 },
  { zona: "FACHADA", partida: "E1 FACHADA", codigo: "PINTM010",   cantidad: 464.49 },

  // FACHADA / E11 LIMPIEZA
  { zona: "FACHADA", partida: "E11 LIMPIEZA", codigo: "LIM001", cantidad: 774.14 },
];

// ─── PRESUPUESTO INTEGRAL partidas ──────────────────────────────────────────

const PARTIDAS_INTEGRAL = [
  // PLANTA BAJA / A1 PRELIMINARES (same as Básico)
  { zona: "PLANTA BAJA", partida: "A1 PRELIMINARES", codigo: "HERB01",    cantidad: 1 },
  { zona: "PLANTA BAJA", partida: "A1 PRELIMINARES", codigo: "APUN001",   cantidad: 31 },
  { zona: "PLANTA BAJA", partida: "A1 PRELIMINARES", codigo: "DEM035",    cantidad: 72.97 },
  { zona: "PLANTA BAJA", partida: "A1 PRELIMINARES", codigo: "DEM002",    cantidad: 13.02 },
  { zona: "PLANTA BAJA", partida: "A1 PRELIMINARES", codigo: "DEM029",    cantidad: 31 },

  // PLANTA BAJA / A2 MURO (Integral adds EXCA001, GRAVARENA, CIM-LOS001, IMP002, GRI-MOR01; REPETALO and PINTM010 quantities are LARGER)
  { zona: "PLANTA BAJA", partida: "A2 MURO", codigo: "REPMURO",    cantidad: 17.22 },
  { zona: "PLANTA BAJA", partida: "A2 MURO", codigo: "EST001",     cantidad: 103.48 },
  { zona: "PLANTA BAJA", partida: "A2 MURO", codigo: "EXCA001",    cantidad: 7.16 },
  { zona: "PLANTA BAJA", partida: "A2 MURO", codigo: "GRAVARENA",  cantidad: 3.26 },
  { zona: "PLANTA BAJA", partida: "A2 MURO", codigo: "CIM-LOS001", cantidad: 31 },
  { zona: "PLANTA BAJA", partida: "A2 MURO", codigo: "BARRO001",   cantidad: 31 },
  { zona: "PLANTA BAJA", partida: "A2 MURO", codigo: "IMP002",     cantidad: 23.52 },
  { zona: "PLANTA BAJA", partida: "A2 MURO", codigo: "GRI-MOR01",  cantidad: 17.59 },
  { zona: "PLANTA BAJA", partida: "A2 MURO", codigo: "GRI-MOR02",  cantidad: 35.82 },
  { zona: "PLANTA BAJA", partida: "A2 MURO", codigo: "REPETALO",   cantidad: 382.53 },
  { zona: "PLANTA BAJA", partida: "A2 MURO", codigo: "PINTM010",   cantidad: 923.83 },

  // PLANTA BAJA / A3 LOSA (same)
  { zona: "PLANTA BAJA", partida: "A3 LOSA", codigo: "VIGMA001",   cantidad: 94.56 },
  { zona: "PLANTA BAJA", partida: "A3 LOSA", codigo: "VIGMA002",   cantidad: 10.5 },
  { zona: "PLANTA BAJA", partida: "A3 LOSA", codigo: "REPTECHO",   cantidad: 55.02 },

  // PLANTA BAJA / A4 IMPERMEABILIZACIÓN (Integral adds IMP003-AZOTEA)
  { zona: "PLANTA BAJA", partida: "A4 IMPERMEABILIZACIÓN", codigo: "IMP003-AZOTEA", cantidad: 12.9 },
  { zona: "PLANTA BAJA", partida: "A4 IMPERMEABILIZACIÓN", codigo: "IMP004",        cantidad: 12.9 },

  // PLANTA BAJA / A5 HERRERÍA (same)
  { zona: "PLANTA BAJA", partida: "A5 HERRERÍA", codigo: "VEHE001", cantidad: 2 },

  // PLANTA BAJA / A6 CARPINTERÍA (same)
  { zona: "PLANTA BAJA", partida: "A6 CARPINTERÍA", codigo: "REPCARP", cantidad: 28.14 },

  // PLANTA BAJA / A7 LIMPIEZA (Integral quantities bigger)
  { zona: "PLANTA BAJA", partida: "A7 LIMPIEZA", codigo: "LIM001", cantidad: 1081.56 },
  { zona: "PLANTA BAJA", partida: "A7 LIMPIEZA", codigo: "LIM005", cantidad: 263.49 },

  // PLANTA ALTA / C1 LOSA (same as Básico)
  { zona: "PLANTA ALTA", partida: "C1 LOSA", codigo: "VIGMA001",  cantidad: 119.56 },
  { zona: "PLANTA ALTA", partida: "C1 LOSA", codigo: "REPTECHO",  cantidad: 113.44 },
  { zona: "PLANTA ALTA", partida: "C1 LOSA", codigo: "GRI-MOR02", cantidad: 29.02 },

  // PLANTA ALTA / C2 MUROS (different quantities — larger in Integral)
  { zona: "PLANTA ALTA", partida: "C2 MUROS", codigo: "REPETALO", cantidad: 221.99 },
  { zona: "PLANTA ALTA", partida: "C2 MUROS", codigo: "PINTM010", cantidad: 621.82 },

  // PLANTA ALTA / C3 PISO (same)
  { zona: "PLANTA ALTA", partida: "C3 PISO", codigo: "VIGMA001", cantidad: 29.48 },

  // PLANTA ALTA / C4 HERRERÍA (same)
  { zona: "PLANTA ALTA", partida: "C4 HERRERÍA", codigo: "VENT001", cantidad: 1 },

  // PLANTA ALTA / C5 CARPINTERÍA (same)
  { zona: "PLANTA ALTA", partida: "C5 CARPINTERÍA", codigo: "REPCARP", cantidad: 28.35 },

  // PLANTA ALTA / C6 INSTALACIÓN (same)
  { zona: "PLANTA ALTA", partida: "C6 INSTALACIÓN", codigo: "INSREG01", cantidad: 1 },

  // PLANTA ALTA / C7 LIMPIEZA (same)
  { zona: "PLANTA ALTA", partida: "C7 LIMPIEZA", codigo: "LIM001", cantidad: 840.17 },
  { zona: "PLANTA ALTA", partida: "C7 LIMPIEZA", codigo: "LIM005", cantidad: 218.35 },

  // PASILLO / B1 PISO (same)
  { zona: "PASILLO", partida: "B1 PISO", codigo: "REPPISO", cantidad: 125.27 },

  // PASILLO / B2 LOSA (Integral bigger quantities + CAN-PLUV01 + LOSATEJ qty bigger)
  { zona: "PASILLO", partida: "B2 LOSA", codigo: "VIGMA001",   cantidad: 100.22 },
  { zona: "PASILLO", partida: "B2 LOSA", codigo: "REPTECHO",   cantidad: 225.49 },
  { zona: "PASILLO", partida: "B2 LOSA", codigo: "CAN-PLUV01", cantidad: 23.18 },
  { zona: "PASILLO", partida: "B2 LOSA", codigo: "LOSATEJ",    cantidad: 214.75 },

  // PASILLO / B21 IMPERMEABILIZACIÓN (new partida in Integral)
  { zona: "PASILLO", partida: "B21 IMPERMEABILIZACIÓN", codigo: "IMP003-AZOTEA", cantidad: 250.54 },

  // AZOTEA / D1 LOSA (bigger quantities)
  { zona: "AZOTEA", partida: "D1 LOSA", codigo: "IMP008",    cantidad: 640.83 },
  { zona: "AZOTEA", partida: "D1 LOSA", codigo: "GRI-MOR02", cantidad: 480.63 },

  // AZOTEA / D2 IMPERMEABILIZANTE (adds IMP003-AZOTEA + bigger IMP004)
  { zona: "AZOTEA", partida: "D2 IMPERMEABILIZANTE", codigo: "IMP003-AZOTEA", cantidad: 640.83 },
  { zona: "AZOTEA", partida: "D2 IMPERMEABILIZANTE", codigo: "IMP004",        cantidad: 640.83 },

  // AZOTEA / D3 HERRERÍA (same)
  { zona: "AZOTEA", partida: "D3 HERRERÍA", codigo: "ESCMET001", cantidad: 1 },
  { zona: "AZOTEA", partida: "D3 HERRERÍA", codigo: "ESCM004",   cantidad: 1 },

  // AZOTEA / D4 INSTALACIÓN (same)
  { zona: "AZOTEA", partida: "D4 INSTALACIÓN", codigo: "TIN-DES", cantidad: 1 },
  { zona: "AZOTEA", partida: "D4 INSTALACIÓN", codigo: "PLUV001", cantidad: 1 },

  // FACHADA / E1 (Integral adds ECXV01, IMP001, REPETALO (exterior), IMP003-MURO)
  { zona: "FACHADA", partida: "E1 FACHADA", codigo: "APUN001",      cantidad: 54.56 },
  { zona: "FACHADA", partida: "E1 FACHADA", codigo: "ECXV01",       cantidad: 20.93 },
  { zona: "FACHADA", partida: "E1 FACHADA", codigo: "IMP001",       cantidad: 69.77 },
  { zona: "FACHADA", partida: "E1 FACHADA", codigo: "GRI-MOR01",    cantidad: 18.19 },
  { zona: "FACHADA", partida: "E1 FACHADA", codigo: "GRI-MOR02",    cantidad: 464.49 },
  { zona: "FACHADA", partida: "E1 FACHADA", codigo: "REPETALO",     cantidad: 442.37 },
  { zona: "FACHADA", partida: "E1 FACHADA", codigo: "PINTM010",     cantidad: 464.49 },
  { zona: "FACHADA", partida: "E1 FACHADA", codigo: "IMP003-MURO",  cantidad: 774.14 },

  // FACHADA / E11 LIMPIEZA (same)
  { zona: "FACHADA", partida: "E11 LIMPIEZA", codigo: "LIM001", cantidad: 774.14 },
];

// Expected totals from the PDFs, used as an assert at the end.
const EXPECTED_BASICO_SUBTOTAL = 1_891_217.07;
const EXPECTED_INTEGRAL_SUBTOTAL = 3_276_354.85;

// ─── Seed runner ─────────────────────────────────────────────────────────────

const round2 = (n) => Math.round(n * 100) / 100;
const log = (...a) => console.log(...a);

async function main() {
  log("\n═══ Seeding Hacienda Ovinos de Ajuluapan ═══\n");

  // 1. Find the company
  const company = await prisma.company.findUnique({
    where: { rfc: COMPANY_RFC },
    include: {
      modules: { where: { habilitado: true }, select: { modulo: true } },
    },
  });
  if (!company) {
    console.error(`❌ Company with RFC ${COMPANY_RFC} not found.`);
    process.exit(1);
  }
  if (!company.modules.some((m) => m.modulo === "CONSTRUCCION")) {
    console.error(`❌ Company ${company.razonSocial} does not have CONSTRUCCION module enabled.`);
    process.exit(1);
  }
  log(`✓ Target company: ${company.razonSocial} (${COMPANY_RFC})`);
  log(`  id: ${company.id}\n`);

  // 2. Upsert conceptos + minimal v1 APUs
  log("Upserting conceptos…");
  const conceptoByCodigo = new Map();
  for (const c of CONCEPTOS) {
    // Upsert concepto (without apuActualId, we attach it after creating the APU)
    const existing = await prisma.concepto.findUnique({
      where: { companyId_codigo: { companyId: company.id, codigo: c.codigo } },
      include: { apus: { orderBy: { version: "desc" }, take: 1 } },
    });

    let concepto;
    if (existing) {
      concepto = await prisma.concepto.update({
        where: { id: existing.id },
        data: {
          descripcion: c.descripcion,
          unidad: c.unidad,
          categoria: c.categoria,
        },
      });
      // Ensure an APU exists and matches PU; update or create
      if (existing.apus.length === 0) {
        const apu = await prisma.aPU.create({
          data: {
            companyId: company.id,
            conceptoId: concepto.id,
            version: 1,
            costoDirecto: 0,
            indirectosPorc: 0,
            financierosPorc: 0,
            utilidadPorc: 0,
            cargosAdicPorc: 0,
            precioUnitario: c.precio,
            rendimiento: 1,
          },
        });
        await prisma.concepto.update({
          where: { id: concepto.id },
          data: { apuActualId: apu.id },
        });
      } else {
        // Snap the current APU's PU to match the source PDF
        await prisma.aPU.update({
          where: { id: existing.apus[0].id },
          data: { precioUnitario: c.precio },
        });
        if (!existing.apuActualId) {
          await prisma.concepto.update({
            where: { id: concepto.id },
            data: { apuActualId: existing.apus[0].id },
          });
        }
      }
    } else {
      concepto = await prisma.concepto.create({
        data: {
          companyId: company.id,
          codigo: c.codigo,
          descripcion: c.descripcion,
          unidad: c.unidad,
          categoria: c.categoria,
        },
      });
      const apu = await prisma.aPU.create({
        data: {
          companyId: company.id,
          conceptoId: concepto.id,
          version: 1,
          costoDirecto: 0,
          indirectosPorc: 0,
          financierosPorc: 0,
          utilidadPorc: 0,
          cargosAdicPorc: 0,
          precioUnitario: c.precio,
          rendimiento: 1,
        },
      });
      await prisma.concepto.update({
        where: { id: concepto.id },
        data: { apuActualId: apu.id },
      });
    }

    // Fetch with apuActual so we have the version number for snapshotting
    const final = await prisma.concepto.findUnique({
      where: { id: concepto.id },
      include: { apuActual: { select: { id: true, version: true } } },
    });
    conceptoByCodigo.set(c.codigo, final);
  }
  log(`  ${CONCEPTOS.length} conceptos upserted\n`);

  // 3. Upsert the proyecto
  log("Upserting proyecto…");
  const proyecto = await prisma.proyecto.upsert({
    where: { companyId_codigo: { companyId: company.id, codigo: PROYECTO_CODIGO } },
    update: {
      nombre: PROYECTO_NOMBRE,
      ubicacion: PROYECTO_UBICACION,
      tipo: "PRIVADO",
      estado: "PLANEACION",
    },
    create: {
      companyId: company.id,
      codigo: PROYECTO_CODIGO,
      nombre: PROYECTO_NOMBRE,
      ubicacion: PROYECTO_UBICACION,
      tipo: "PRIVADO",
      estado: "PLANEACION",
      // montoContratado left NULL — customer decides between Básico and Integral
    },
  });
  log(`  ${proyecto.codigo}: ${proyecto.nombre}\n`);

  // 4. Wipe existing presupuestos on this proyecto and create the two fresh
  log("Wiping existing presupuestos on this proyecto…");
  await prisma.presupuesto.deleteMany({ where: { proyectoId: proyecto.id } });

  async function createPresupuesto(nombre, version, partidas) {
    const resolved = partidas.map((p, idx) => {
      const c = conceptoByCodigo.get(p.codigo);
      if (!c) throw new Error(`Missing concepto: ${p.codigo}`);
      const precioUnitario = CONCEPTOS.find((x) => x.codigo === p.codigo).precio;
      const importe = round2(p.cantidad * precioUnitario);
      return {
        conceptoId: c.id,
        apuVersion: c.apuActual?.version ?? 1,
        cantidad: p.cantidad,
        precioUnitario,
        importe,
        orden: idx,
        zona: p.zona,
        partida: p.partida,
      };
    });
    const montoTotal = round2(resolved.reduce((a, p) => a + p.importe, 0));

    return prisma.presupuesto.create({
      data: {
        companyId: company.id,
        proyectoId: proyecto.id,
        nombre,
        version,
        estado: "BORRADOR",
        montoTotal,
        partidas: { create: resolved },
      },
    });
  }

  log("Creating presupuesto: Mantenimiento Básico…");
  const basico = await createPresupuesto("Mantenimiento Básico", 1, PARTIDAS_BASICO);
  log(`  ✓ ${PARTIDAS_BASICO.length} partidas, total = $${basico.montoTotal.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

  log("Creating presupuesto: Rehabilitación Integral…");
  const integral = await createPresupuesto("Rehabilitación Integral", 2, PARTIDAS_INTEGRAL);
  log(`  ✓ ${PARTIDAS_INTEGRAL.length} partidas, total = $${integral.montoTotal.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`);

  // 5. Verify totals match the PDFs
  log("Verifying totals against source PDFs…");
  const basicoDiff = Math.abs(basico.montoTotal - EXPECTED_BASICO_SUBTOTAL);
  const integralDiff = Math.abs(integral.montoTotal - EXPECTED_INTEGRAL_SUBTOTAL);
  const okBasico = basicoDiff < 0.02; // allow 2 cent rounding drift
  const okIntegral = integralDiff < 0.02;
  log(
    `  Básico:   ${okBasico ? "✅" : "❌"} $${basico.montoTotal.toFixed(2)} vs PDF $${EXPECTED_BASICO_SUBTOTAL.toFixed(2)} (drift $${basicoDiff.toFixed(2)})`
  );
  log(
    `  Integral: ${okIntegral ? "✅" : "❌"} $${integral.montoTotal.toFixed(2)} vs PDF $${EXPECTED_INTEGRAL_SUBTOTAL.toFixed(2)} (drift $${integralDiff.toFixed(2)})`
  );

  if (!okBasico || !okIntegral) {
    console.error("\n⚠️  Totals do NOT match the source PDFs — check quantities!");
    process.exit(1);
  }

  const ivaBasico = round2(basico.montoTotal * 0.16);
  const ivaIntegral = round2(integral.montoTotal * 0.16);
  log(`\n─── Comparativo para el meeting ─────────────────────`);
  log(`  Básico    subtotal $${basico.montoTotal.toLocaleString("es-MX")} + IVA $${ivaBasico.toLocaleString("es-MX")} = $${(basico.montoTotal + ivaBasico).toLocaleString("es-MX")}`);
  log(`  Integral  subtotal $${integral.montoTotal.toLocaleString("es-MX")} + IVA $${ivaIntegral.toLocaleString("es-MX")} = $${(integral.montoTotal + ivaIntegral).toLocaleString("es-MX")}`);
  log(`─────────────────────────────────────────────────────\n`);

  log("✅ Done. Both presupuestos are in BORRADOR state.");
  log("   After the meeting:");
  log("     • Flip the chosen one to APROBADO");
  log("     • Flip the other to RECHAZADO");
  log("     • Set Proyecto.montoContratado = chosen subtotal\n");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
