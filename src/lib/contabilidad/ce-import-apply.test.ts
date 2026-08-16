import { describe, it, expect, beforeEach, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Un catálogo SIN `Desc` no debe borrar el nombre de una cuenta.
//
// El upsert escribía `nombre: c.desc || c.numCta` también en el UPDATE, así que
// un catálogo que trajera la cuenta sin descripción machacaba el nombre bueno
// con el propio código. Queda una fila que PARECE nombrada —`nombre` no es
// null— pero cuyo nombre es el número, y toda conciliación por familia le manda
// su dinero al bucket «sin explicar».
//
// Medido en MARGOM (2026-08): 16 cuentas así; `1301-0028-0000` sola con $6.98M.
// ─────────────────────────────────────────────────────────────────────────────

type Cuenta = {
  id: string;
  companyId: string;
  cuentaSAT: string;
  subcuenta: string | null;
  nombre: string;
  tipo: string;
  nivel: number;
  naturaleza: string | null;
  isActive?: boolean;
};

const state = vi.hoisted(() => ({ rows: [] as Cuenta[], seq: 0 }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    chartAccount: {
      findFirst: async ({
        where,
      }: {
        where: { companyId: string; cuentaSAT: string; subcuenta: string | null };
      }) =>
        state.rows.find(
          (r) =>
            r.companyId === where.companyId &&
            r.cuentaSAT === where.cuentaSAT &&
            (r.subcuenta ?? null) === (where.subcuenta ?? null),
        ) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<Cuenta> }) => {
        const row = state.rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      create: async ({ data }: { data: Omit<Cuenta, "id"> }) => {
        const row = { id: `c${++state.seq}`, ...data };
        state.rows.push(row);
        return row;
      },
    },
  },
}));

const { importarCatalogo } = await import("./ce-import-apply");

/** Catálogo Anexo 24 con una sola cuenta; `desc` vacío = sin atributo Desc. */
function catalogoCon(numCta: string, desc: string): string {
  const attrDesc = desc ? ` Desc="${desc}"` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<catalogocuentas:Catalogo xmlns:catalogocuentas="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas"
  Version="1.3" RFC="AMA170817NK1" Mes="03" Anio="2025">
  <catalogocuentas:Ctas CodAgrup="115" NumCta="${numCta}"${attrDesc} Nivel="2" Natur="D"/>
</catalogocuentas:Catalogo>`;
}

describe("importarCatalogo — el nombre de una cuenta no se pierde", () => {
  beforeEach(() => {
    state.rows = [];
    state.seq = 0;
  });

  it("guarda la descripción cuando el catálogo la trae", async () => {
    await importarCatalogo("emp1", catalogoCon("1301-0028-0000", "TRAVELER"));
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].nombre).toBe("TRAVELER");
  });

  it("NO machaca un nombre real con el código cuando el catálogo viene sin Desc", async () => {
    await importarCatalogo("emp1", catalogoCon("1301-0028-0000", "TRAVELER"));
    // Un catálogo posterior trae la misma cuenta pero sin descripción.
    await importarCatalogo("emp1", catalogoCon("1301-0028-0000", ""));
    // Antes quedaba "1301-0028-0000" y sus $6.98M se volvían inexplicables.
    expect(state.rows[0].nombre).toBe("TRAVELER");
  });

  it("al CREAR sin Desc deja el código de marcador — `nombre` es obligatorio", async () => {
    await importarCatalogo("emp1", catalogoCon("1301-0031-0000", ""));
    expect(state.rows[0].nombre).toBe("1301-0031-0000");
  });

  it("un catálogo posterior CON Desc sí reemplaza el marcador", async () => {
    await importarCatalogo("emp1", catalogoCon("1301-0031-0000", ""));
    await importarCatalogo("emp1", catalogoCon("1301-0031-0000", "JAC SUNRAY"));
    expect(state.rows[0].nombre).toBe("JAC SUNRAY");
    // Y sigue siendo UNA cuenta: el upsert empata, no duplica.
    expect(state.rows).toHaveLength(1);
  });
});
