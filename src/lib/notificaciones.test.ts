import { describe, it, expect } from "vitest";
import {
  siguienteEstado,
  decidirNotificacion,
  fechaLocalMx,
  inicioDelDiaMx,
  type ItemExistenteSnapshot,
} from "./notificaciones";

const now = new Date("2026-06-30T12:00:00Z");
const futuro = new Date("2026-07-15T12:00:00Z");
const pasado = new Date("2026-06-01T12:00:00Z");

describe("siguienteEstado", () => {
  it("NUEVO re-disparado sigue NUEVO", () => {
    expect(siguienteEstado("NUEVO", null, now)).toBe("NUEVO");
  });

  it("VISTO re-disparado vuelve a NUEVO (alerta es nueva otra vez)", () => {
    expect(siguienteEstado("VISTO", null, now)).toBe("NUEVO");
  });

  it("HECHO re-disparado se respeta (no re-molestar)", () => {
    expect(siguienteEstado("HECHO", null, now)).toBe("HECHO");
    // HECHO se respeta aunque hubiera un posponerHasta colgando.
    expect(siguienteEstado("HECHO", pasado, now)).toBe("HECHO");
    expect(siguienteEstado("HECHO", futuro, now)).toBe("HECHO");
  });

  it("POSPUESTO vigente (snooze en el futuro) sigue POSPUESTO", () => {
    expect(siguienteEstado("POSPUESTO", futuro, now)).toBe("POSPUESTO");
  });

  it("POSPUESTO vencido (snooze en el pasado) reaparece como NUEVO", () => {
    expect(siguienteEstado("POSPUESTO", pasado, now)).toBe("NUEVO");
  });

  it("POSPUESTO sin fecha se trata como vencido → NUEVO", () => {
    expect(siguienteEstado("POSPUESTO", null, now)).toBe("NUEVO");
  });

  it("POSPUESTO exactamente en `now` ya no es futuro → NUEVO", () => {
    expect(siguienteEstado("POSPUESTO", now, now)).toBe("NUEVO");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// decidirNotificacion — la decisión completa de un disparo: push sólo en
// transiciones reales; sin novedad = silencio total (anti-spam de crons 3×/día).
// ─────────────────────────────────────────────────────────────────────────────

const contenido = { titulo: "3 facturas nuevas hoy", cuerpo: "Acme — 3 recibidas ($1,000.00)" };
const contenidoNuevo = { titulo: "5 facturas nuevas hoy", cuerpo: "Acme — 5 recibidas ($2,500.00)" };

const item = (o: Partial<ItemExistenteSnapshot> = {}): ItemExistenteSnapshot => ({
  estado: "NUEVO",
  posponerHasta: null,
  titulo: contenido.titulo,
  cuerpo: contenido.cuerpo,
  ...o,
});

describe("decidirNotificacion", () => {
  it("item nuevo (no existía) → crear + push", () => {
    const d = decidirNotificacion(null, contenido, now);
    expect(d).toEqual({ crear: true, estado: "NUEVO", actualizar: true, limpiarSnooze: false, push: true });
  });

  it("item nuevo empuja incluso con pushSoloAlCrear (el push es de la creación)", () => {
    const d = decidirNotificacion(null, contenido, now, { pushSoloAlCrear: true });
    expect(d.crear).toBe(true);
    expect(d.push).toBe(true);
  });

  it("re-disparo idéntico en NUEVO → silencio total (sin push, sin escritura)", () => {
    const d = decidirNotificacion(item({ estado: "NUEVO" }), contenido, now);
    expect(d).toEqual({ crear: false, estado: "NUEVO", actualizar: false, limpiarSnooze: false, push: false });
  });

  it("re-disparo idéntico en VISTO → sin push y SIN flip VISTO→NUEVO (leerlo se pega)", () => {
    const d = decidirNotificacion(item({ estado: "VISTO" }), contenido, now);
    expect(d).toEqual({ crear: false, estado: "VISTO", actualizar: false, limpiarSnooze: false, push: false });
  });

  it("contenido nuevo en VISTO → vuelve a NUEVO, actualiza y empuja", () => {
    const d = decidirNotificacion(item({ estado: "VISTO" }), contenidoNuevo, now);
    expect(d).toEqual({ crear: false, estado: "NUEVO", actualizar: true, limpiarSnooze: false, push: true });
  });

  it("contenido nuevo en NUEVO → actualiza y empuja (novedad real aunque no haya flip)", () => {
    const d = decidirNotificacion(item({ estado: "NUEVO" }), contenidoNuevo, now);
    expect(d.actualizar).toBe(true);
    expect(d.push).toBe(true);
    expect(d.estado).toBe("NUEVO");
  });

  it("basta con que cambie sólo el cuerpo (o sólo el título) para ser novedad", () => {
    const soloCuerpo = { titulo: contenido.titulo, cuerpo: "otro cuerpo" };
    expect(decidirNotificacion(item(), soloCuerpo, now).push).toBe(true);
    const soloTitulo = { titulo: "otro título", cuerpo: contenido.cuerpo };
    expect(decidirNotificacion(item(), soloTitulo, now).push).toBe(true);
  });

  it("pushSoloAlCrear: contenido nuevo actualiza el inbox EN SILENCIO (tope diario CFDI)", () => {
    const d = decidirNotificacion(item({ estado: "NUEVO" }), contenidoNuevo, now, { pushSoloAlCrear: true });
    expect(d.actualizar).toBe(true); // el conteo del día se acumula en el inbox
    expect(d.push).toBe(false); // pero ya se empujó al crear: no más push hoy
    expect(d.estado).toBe("NUEVO");
  });

  it("HECHO + re-disparo idéntico → nada (no revive, no empuja, no escribe)", () => {
    const d = decidirNotificacion(item({ estado: "HECHO" }), contenido, now);
    expect(d).toEqual({ crear: false, estado: "HECHO", actualizar: false, limpiarSnooze: false, push: false });
  });

  it("HECHO + contenido nuevo → refresca el inbox pero sigue HECHO y sin push", () => {
    const d = decidirNotificacion(item({ estado: "HECHO" }), contenidoNuevo, now);
    expect(d).toEqual({ crear: false, estado: "HECHO", actualizar: true, limpiarSnooze: false, push: false });
  });

  it("POSPUESTO vigente → no molestar (ni con contenido nuevo hay push)", () => {
    const d = decidirNotificacion(item({ estado: "POSPUESTO", posponerHasta: futuro }), contenidoNuevo, now);
    expect(d.estado).toBe("POSPUESTO");
    expect(d.push).toBe(false);
    expect(d.actualizar).toBe(true); // el contenido sí se refresca
    const sinCambio = decidirNotificacion(item({ estado: "POSPUESTO", posponerHasta: futuro }), contenido, now);
    expect(sinCambio.actualizar).toBe(false);
  });

  it("POSPUESTO vencido → transición real: NUEVO + push aunque el contenido sea idéntico", () => {
    const d = decidirNotificacion(item({ estado: "POSPUESTO", posponerHasta: pasado }), contenido, now);
    expect(d).toEqual({ crear: false, estado: "NUEVO", actualizar: true, limpiarSnooze: true, push: true });
  });

  it("POSPUESTO vencido con pushSoloAlCrear → reaparece en el inbox pero sin push", () => {
    const d = decidirNotificacion(item({ estado: "POSPUESTO", posponerHasta: pasado }), contenido, now, {
      pushSoloAlCrear: true,
    });
    expect(d.estado).toBe("NUEVO");
    expect(d.limpiarSnooze).toBe(true);
    expect(d.push).toBe(false);
  });
});

describe("fechaLocalMx / inicioDelDiaMx", () => {
  it("da la fecha local de CDMX (UTC-6): las 03:00Z del 1-jul aún son 30-jun", () => {
    expect(fechaLocalMx(new Date("2026-07-01T03:00:00Z"))).toBe("2026-06-30");
    expect(fechaLocalMx(new Date("2026-07-01T12:00:00Z"))).toBe("2026-07-01");
  });

  it("inicioDelDiaMx es la medianoche CDMX (06:00Z) del día local", () => {
    expect(inicioDelDiaMx(new Date("2026-07-01T12:00:00Z")).toISOString()).toBe("2026-07-01T06:00:00.000Z");
    expect(inicioDelDiaMx(new Date("2026-07-01T03:00:00Z")).toISOString()).toBe("2026-06-30T06:00:00.000Z");
  });

  it("simulación del día CFDI: 1er sync crea y empuja; el 2º acumula en silencio", () => {
    const dia = fechaLocalMx(now);
    const key = `cfdi-nuevos:c1:${dia}`;
    expect(key).toBe("cfdi-nuevos:c1:2026-06-30");
    // 1er sync del día: no existe el item → crear + push.
    const primero = decidirNotificacion(null, contenido, now, { pushSoloAlCrear: true });
    expect(primero.push).toBe(true);
    // 2º sync del día: mismo key, conteo acumulado distinto → inbox sí, push no.
    const segundo = decidirNotificacion(item(), contenidoNuevo, now, { pushSoloAlCrear: true });
    expect(segundo.actualizar).toBe(true);
    expect(segundo.push).toBe(false);
  });
});
