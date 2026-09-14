import { beforeEach, describe, expect, it, vi } from "vitest";

// La carrera que se vio en producción (14-sep-2026): registrar_partes y
// actualizar_asunto corren en paralelo en la misma ronda y ambas piden «el
// asunto de esta conversación, créalo si no hay». Sin la guarda, la
// conversación terminaba con DOS casos.
const estado = {
  conversacion: { id: "conv1", userId: "u1", titulo: "Demanda de arrendamiento", casoId: null as string | null },
  casos: new Map<string, { id: string; userId: string; titulo: string }>(),
  creados: 0,
  borrados: [] as string[],
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    juridicoConversacion: {
      findFirst: async () => (estado.conversacion ? { casoId: estado.conversacion.casoId, titulo: estado.conversacion.titulo } : null),
      findUnique: async () => ({ casoId: estado.conversacion.casoId }),
      // updateMany con `casoId: null` es la guarda: sólo pega si nadie ganó antes.
      updateMany: async ({ where, data }: { where: { casoId: null | string }; data: { casoId: string } }) => {
        if (where.casoId === null && estado.conversacion.casoId !== null) return { count: 0 };
        estado.conversacion.casoId = data.casoId;
        return { count: 1 };
      },
    },
    juridicoCaso: {
      create: async ({ data }: { data: { userId: string; titulo: string } }) => {
        estado.creados++;
        const caso = { id: `caso${estado.creados}`, userId: data.userId, titulo: data.titulo, partes: [], decisiones: [] };
        estado.casos.set(caso.id, caso);
        return caso;
      },
      findFirst: async ({ where }: { where: { id: string } }) => {
        const c = estado.casos.get(where.id);
        return c ? { ...c, partes: [], decisiones: [] } : null;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        estado.borrados.push(where.id);
        estado.casos.delete(where.id);
        return {};
      },
    },
    juridicoDocumento: { updateMany: async () => ({ count: 0 }) },
  },
}));
vi.mock("./bitacora", () => ({ apuntar: async () => "b1" }));

import { asuntoDeConversacion } from "./asuntos";

describe("un caso por conversación, aunque dos herramientas lo pidan a la vez", () => {
  beforeEach(() => {
    estado.conversacion.casoId = null;
    estado.casos.clear();
    estado.creados = 0;
    estado.borrados = [];
  });

  it("dos llamadas en paralelo devuelven el MISMO caso y el sobrante se borra", async () => {
    const [a, b] = await Promise.all([
      asuntoDeConversacion("conv1", "u1", { crear: true }),
      asuntoDeConversacion("conv1", "u1", { crear: true }),
    ]);
    expect(a?.id).toBeTruthy();
    expect(a?.id).toBe(b?.id);
    expect(estado.creados).toBe(2); // las dos intentaron…
    expect(estado.borrados).toHaveLength(1); // …pero sólo queda una
    expect(estado.casos.size).toBe(1);
    expect(estado.conversacion.casoId).toBe(a?.id);
  });

  it("sin crear, una conversación sin caso devuelve null y no crea nada", async () => {
    expect(await asuntoDeConversacion("conv1", "u1")).toBeNull();
    expect(estado.creados).toBe(0);
  });
});
