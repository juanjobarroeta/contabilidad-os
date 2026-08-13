import { describe, it, expect } from "vitest";
import { clasificarConcepto } from "./concepto-linea";

// ─────────────────────────────────────────────────────────────────────────────
// Dos derivadores leían los mismos conceptos con criterios distintos. Este
// archivo fija el criterio ÚNICO que ahora usan los dos.
// ─────────────────────────────────────────────────────────────────────────────

describe("clasificarConcepto()", () => {
  it("una parte que se llama «reparación» es REFACCION, no mano de obra", () => {
    // El caso que causó $28.9M de doble conteo en 5,424 facturas de Margom: el
    // catálogo está lleno de partes con «REPARACIÓN» en el nombre.
    for (const descripcion of [
      "KIT DE REPARACION DE CALIPER",
      "KIT DE REPARACION DE PLACAS DE FRICCION TRASERAS",
      "BOLSA DE REPARACIÓN DE FORRO DE CESTA DE BOLA",
      "KIT DE MANTENIMIENTO DEL CONJUNTO DEL DISCO",
    ]) {
      expect(clasificarConcepto({ claveProdServ: "25171700", noIdentificacion: "04152-YZZA1", descripcion }))
        .toBe("REFACCION");
    }
  });

  it("la clave 7818 del SAT gana sobre el número de parte", () => {
    // Un taller SÍ codifica sus operaciones: la clave autoritativa manda.
    expect(clasificarConcepto({ claveProdServ: "78181500", noIdentificacion: "OP-4471", descripcion: "AJUSTE DE 4 PUERTAS" }))
      .toBe("MANO_OBRA");
  });

  it("sin número de parte, el texto sí decide", () => {
    expect(clasificarConcepto({ claveProdServ: "25101500", noIdentificacion: null, descripcion: "LAVADO Y PULIDO" }))
      .toBe("MANO_OBRA");
  });

  it("el anticipo no es ninguna de las dos, aunque su descripción diga SERVICIO", () => {
    expect(clasificarConcepto({ claveProdServ: "84111506", descripcion: "Anticipo del bien o servicio" }))
      .toBe("NINGUNA");
    expect(clasificarConcepto({ claveProdServ: "84111506", noIdentificacion: "ANT-1", descripcion: "ANTICIPO CAMIONES YUTONG" }))
      .toBe("NINGUNA");
  });

  it("«MANO DE OBRA» como número de parte no crea una refacción llamada así", () => {
    expect(clasificarConcepto({ claveProdServ: "25171700", noIdentificacion: "MANO DE OBRA", descripcion: "Mano de obra" }))
      .toBe("MANO_OBRA");
  });

  it("lo que no es ni una cosa ni la otra no se fuerza a ninguna línea", () => {
    expect(clasificarConcepto({ claveProdServ: "80141600", descripcion: "BONO FLOTILLAS" })).toBe("NINGUNA");
  });
});
