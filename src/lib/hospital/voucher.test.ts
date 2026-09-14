import { describe, expect, it } from "vitest";
import {
  esPropuestaFirme,
  mismoTitular,
  proponerFacturas,
  type CandidatoFactura,
  type VoucherLeido,
} from "./voucher";

const voucher = (p: Partial<VoucherLeido> = {}): VoucherLeido => ({
  monto: 3770,
  fecha: "2026-08-17",
  afiliacion: "09992888C",
  autorizacion: "123456",
  ultimos4: "4321",
  marca: "VISA",
  tipoTarjeta: "CREDITO",
  tarjetahabiente: null,
  ...p,
});

const factura = (p: Partial<CandidatoFactura> & { invoiceId: string }): CandidatoFactura => ({
  folio: "1000",
  uuid: null,
  total: 3770,
  cobrado: 0,
  fecha: "2026-08-17",
  receptorNombre: "PACIENTE UNO",
  receptorRfc: null,
  ...p,
});

describe("mismoTitular", () => {
  // El voucher imprime apellidos primero y el nombre truncado.
  it("reconoce a la persona aunque el voucher invierta y abrevie", () => {
    expect(mismoTitular("GONZALEZ RUIZ/ROSA M", "ROSA MARIA GONZALEZ RUIZ")).toBe(true);
    expect(mismoTitular("SPINOLA HERNANDEZ/JAVIER E", "JAVIER EDUARDO SPINOLA HERNANDEZ")).toBe(true);
  });

  it("no empareja a dos personas distintas", () => {
    expect(mismoTitular("GONZALEZ RUIZ/ROSA M", "JAVIER EDUARDO SPINOLA HERNANDEZ")).toBe(false);
  });

  // Un solo apellido común (MARTINEZ, HERNANDEZ) no identifica a nadie en México.
  it("un apellido suelto no basta", () => {
    expect(mismoTitular("HERNANDEZ/JUAN", "MARIA HERNANDEZ LOPEZ")).toBe(false);
  });

  it("sin nombre en el voucher no inventa coincidencia", () => {
    expect(mismoTitular(null, "ROSA MARIA GONZALEZ RUIZ")).toBe(false);
    expect(mismoTitular("GONZALEZ RUIZ/ROSA M", null)).toBe(false);
  });
});

describe("proponerFacturas", () => {
  it("no propone facturas ya cobradas", () => {
    const p = proponerFacturas(voucher(), [factura({ invoiceId: "a", total: 3770, cobrado: 3770 })]);
    expect(p).toHaveLength(0);
  });

  it("sin monto legible no propone nada", () => {
    expect(proponerFacturas(voucher({ monto: null }), [factura({ invoiceId: "a" })])).toHaveLength(0);
  });

  // LA LECCIÓN DE AGOSTO. Cinco facturas de $3,770 en ocho días: el importe
  // solo no distingue una de otra. El nombre de la tarjeta sí.
  it("el titular de la tarjeta gana sobre el empate de importe", () => {
    const p = proponerFacturas(
      voucher({ tarjetahabiente: "PEREZ REFUGIO/JOSE A" }),
      [
        factura({ invoiceId: "otra", receptorNombre: "MARIA CRISTINA SOSA GARCIA" }),
        factura({ invoiceId: "suya", receptorNombre: "JOSE ALBERTO PEREZ REFUGIO" }),
      ],
    );
    expect(p[0].invoiceId).toBe("suya");
    expect(p[0].razones[0]).toMatch(/la tarjeta va a nombre de/);
  });

  it("explica en palabras verificables por qué propone", () => {
    const p = proponerFacturas(voucher(), [factura({ invoiceId: "a" })]);
    expect(p[0].razones).toContain("el importe es exactamente el saldo");
    expect(p[0].razones).toContain("misma fecha");
  });

  it("un abono parcial se propone y se dice que es parcial", () => {
    const p = proponerFacturas(voucher({ monto: 1000 }), [factura({ invoiceId: "a", total: 4000 })]);
    expect(p[0].razones.some((r) => /abona 25 % del saldo/.test(r))).toBe(true);
  });

  it("un cobro que pasa del saldo se propone al final y lo advierte", () => {
    const p = proponerFacturas(voucher({ monto: 9000 }), [
      factura({ invoiceId: "cabe", total: 9000 }),
      factura({ invoiceId: "pasa", total: 500 }),
    ]);
    expect(p[0].invoiceId).toBe("cabe");
    expect(p[1].razones).toContain("el importe pasa del saldo");
  });

  it("prefiere la del mismo día entre dos con el mismo importe", () => {
    const p = proponerFacturas(voucher({ fecha: "2026-08-17" }), [
      factura({ invoiceId: "lejos", fecha: "2026-06-02" }),
      factura({ invoiceId: "hoy", fecha: "2026-08-17" }),
    ]);
    expect(p[0].invoiceId).toBe("hoy");
  });

  it("descuenta lo ya cobrado al calcular el saldo", () => {
    const p = proponerFacturas(voucher({ monto: 1000 }), [factura({ invoiceId: "a", total: 5000, cobrado: 4000 })]);
    expect(p[0].saldo).toBe(1000);
    expect(p[0].razones).toContain("el importe es exactamente el saldo");
  });
});

describe("esPropuestaFirme", () => {
  it("no preselecciona cuando hay dos candidatas parejas", () => {
    // Dos facturas idénticas del mismo día: exactamente el caso de los $3,770.
    const p = proponerFacturas(voucher(), [
      factura({ invoiceId: "a", receptorNombre: "UNO" }),
      factura({ invoiceId: "b", receptorNombre: "DOS" }),
    ]);
    expect(p).toHaveLength(2);
    expect(esPropuestaFirme(p)).toBe(false);
  });

  it("preselecciona cuando la tarjeta nombra a la persona", () => {
    const p = proponerFacturas(voucher({ tarjetahabiente: "PEREZ REFUGIO/JOSE A" }), [
      factura({ invoiceId: "suya", receptorNombre: "JOSE ALBERTO PEREZ REFUGIO" }),
      factura({ invoiceId: "otra", receptorNombre: "MARIA CRISTINA SOSA GARCIA" }),
    ]);
    expect(esPropuestaFirme(p)).toBe(true);
  });

  it("sin candidatas no hay nada firme", () => {
    expect(esPropuestaFirme([])).toBe(false);
  });
});
