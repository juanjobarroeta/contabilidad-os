// ─────────────────────────────────────────────────────────────────────────────
// Altas desde la agenda: quien agenda escribe el nombre del paciente, del
// médico o del anestesiólogo que todavía no existen y el hub los da de alta en
// la MISMA transacción de la cita, para poder ligarlos después:
//
//   · Paciente: nombre + fecha de nacimiento (obligatoria) → ficha mínima con
//     su número de expediente. Al ingresar se completa (CURP, responsable…).
//     Si ya hay uno con el mismo nombre y la misma fecha, se liga a ése.
//   · Médico / anestesiólogo: sólo el nombre → HospMedico con
//     `porCredencializar`, que sale en «Requiere atención» hasta que alguien
//     captura su cédula y lo marca. Si ya existe uno activo con ese nombre, se
//     liga a ése.
//
// Así quien sólo tiene «Programar agenda» no necesita permisos de pacientes
// ni de médicos para dejar la cita completa.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma } from "@prisma/client";
import { siguienteFolio } from "./folio";
import { dividirNombre, normalizarNombre } from "./identidad";
import { fechaNacimientoDe } from "./paciente-schema";

type Tx = Prisma.TransactionClient;

export interface AltasCitaEntrada {
  pacienteId?: string | null;
  medicoId?: string | null;
  anestesiologoId?: string | null;
  pacienteNuevo?: { nombre: string; fechaNacimiento: string };
  medicoNuevo?: { nombre: string };
  anestesiologoNuevo?: { nombre: string };
}

export interface AltaCita {
  entidad: "HospPaciente" | "HospMedico";
  id: string;
  nombre: string;
  rol: "PACIENTE" | "MEDICO" | "ANESTESIOLOGO";
  nuevo: boolean;
}

export type ResultadoAltas =
  | { error: string }
  | { error: null; pacienteId?: string; medicoId?: string; anestesiologoId?: string; altas: AltaCita[] };

const ESPECIALIDAD_ANESTESIA = "Anestesiología";

export async function resolverAltasCita(tx: Tx, companyId: string, d: AltasCitaEntrada, hoy = new Date()): Promise<ResultadoAltas> {
  const out: { pacienteId?: string; medicoId?: string; anestesiologoId?: string; altas: AltaCita[] } = { altas: [] };

  if (d.pacienteNuevo && !d.pacienteId) {
    const partes = dividirNombre(d.pacienteNuevo.nombre);
    if (!partes) return { error: "Escribe nombre y al menos un apellido del paciente" };
    const fechaNacimiento = fechaNacimientoDe(d.pacienteNuevo.fechaNacimiento);
    if (!fechaNacimiento || fechaNacimiento > hoy) return { error: "La fecha de nacimiento del paciente no es válida" };
    const nombre = [partes.nombres, partes.apellidoPaterno, partes.apellidoMaterno].filter(Boolean).join(" ");
    const mismos = await tx.hospPaciente.findMany({
      where: { companyId, fechaNacimiento, apellidoPaterno: { equals: partes.apellidoPaterno, mode: "insensitive" } },
      select: { id: true, nombre: true, apellidoPaterno: true, apellidoMaterno: true },
    });
    const clave = normalizarNombre(nombre);
    const existente = mismos.find((p) => normalizarNombre([p.nombre, p.apellidoPaterno, p.apellidoMaterno].filter(Boolean).join(" ")) === clave);
    if (existente) {
      out.pacienteId = existente.id;
      out.altas.push({ entidad: "HospPaciente", id: existente.id, nombre, rol: "PACIENTE", nuevo: false });
    } else {
      const expedienteNumero = await siguienteFolio(tx, companyId, "expediente", hoy);
      const p = await tx.hospPaciente.create({
        data: { companyId, nombre: partes.nombres, apellidoPaterno: partes.apellidoPaterno, apellidoMaterno: partes.apellidoMaterno, fechaNacimiento, expedienteNumero },
        select: { id: true },
      });
      out.pacienteId = p.id;
      out.altas.push({ entidad: "HospPaciente", id: p.id, nombre, rol: "PACIENTE", nuevo: true });
    }
  }

  const medico = async (nombreCrudo: string, rol: "MEDICO" | "ANESTESIOLOGO"): Promise<string> => {
    const nombre = nombreCrudo.replace(/\s+/g, " ").trim();
    const clave = normalizarNombre(nombre);
    const activos = await tx.hospMedico.findMany({ where: { companyId, activo: true }, select: { id: true, nombre: true } });
    const existente = activos.find((m) => normalizarNombre(m.nombre) === clave);
    if (existente) {
      out.altas.push({ entidad: "HospMedico", id: existente.id, nombre: existente.nombre, rol, nuevo: false });
      return existente.id;
    }
    const partes = dividirNombre(nombre);
    const m = await tx.hospMedico.create({
      data: {
        companyId,
        nombre,
        especialidad: rol === "ANESTESIOLOGO" ? ESPECIALIDAD_ANESTESIA : null,
        nombres: partes?.nombres ?? null,
        apellidoPaterno: partes?.apellidoPaterno ?? null,
        apellidoMaterno: partes?.apellidoMaterno ?? null,
        paisNacimientoClave: "142",
        porCredencializar: true,
      },
      select: { id: true },
    });
    out.altas.push({ entidad: "HospMedico", id: m.id, nombre, rol, nuevo: true });
    return m.id;
  };

  if (d.medicoNuevo && !d.medicoId) out.medicoId = await medico(d.medicoNuevo.nombre, "MEDICO");
  if (d.anestesiologoNuevo && !d.anestesiologoId) out.anestesiologoId = await medico(d.anestesiologoNuevo.nombre, "ANESTESIOLOGO");

  return { error: null, ...out };
}
