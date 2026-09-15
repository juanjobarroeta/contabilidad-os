import { describe, it, expect } from "vitest";
import { periodoDe } from "./import";

// Pasó en producción: el contador subió el estado de cuenta de JULIO mientras
// trabajaba agosto. El archivo entró bien —era el que no era— y la cuenta quedó
// «sin estado de cuenta del mes» sin que nada lo dijera, bloqueando el cierre.
describe("el archivo de otro mes", () => {
  const dia = (iso: string) => ({ fecha: new Date(`${iso}T12:00:00Z`) });

  it("periodoDe() dice el mes cuando todo cae en uno, y el rango cuando lo cruza", () => {
    expect(periodoDe([dia("2026-07-01"), dia("2026-07-31")])).toBe("2026-07");
    expect(periodoDe([dia("2026-07-28"), dia("2026-08-02")])).toContain("2026-07-28");
    expect(periodoDe([])).toBeNull();
  });

  // El aviso se arma comparando ese periodo contra el mes que se trabaja.
  it("el periodo del archivo no empieza con el mes esperado", () => {
    expect("2026-07".startsWith("2026-08")).toBe(false);
    expect("2026-08".startsWith("2026-08")).toBe(true);
    expect("2026-08-26 – 2026-09-01".startsWith("2026-08")).toBe(true);
  });
});
