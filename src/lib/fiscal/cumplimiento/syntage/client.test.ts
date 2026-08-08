import { afterEach, describe, expect, it, vi } from "vitest";
import { SyntageClient } from "./client";

// La API de Syntage (API Platform) pagina TODAS las colecciones (~30 por
// página por default). Un GET sin paginar sólo ve la primera página: las
// entidades que caigan después se vuelven invisibles para findEntityByRfc y
// ensureEntity crea duplicados. Estos tests fijan el contrato de paginación.

function stubFetchPaginado(porPagina: Record<string, unknown>[][]) {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    const page = Number(new URL(String(url)).searchParams.get("page") ?? "1");
    const member = porPagina[page - 1] ?? [];
    return new Response(JSON.stringify({ "hydra:member": member }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("SyntageClient paginación de colecciones", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("listEntities junta todas las páginas hasta la página corta", async () => {
    const pagina1 = Array.from({ length: 200 }, (_, i) => ({ id: `e${i}` }));
    const pagina2 = [{ id: "e200", rfc: "AGO150704NA9" }];
    const fetchMock = stubFetchPaginado([pagina1, pagina2]);

    const client = new SyntageClient({ apiKey: "test" });
    const list = await client.listEntities();

    expect(list).toHaveLength(201);
    expect(fetchMock).toHaveBeenCalledTimes(2); // página corta → no pide la 3a
  });

  it("una sola página corta no dispara peticiones extra", async () => {
    const fetchMock = stubFetchPaginado([[{ id: "e1" }]]);
    const client = new SyntageClient({ apiKey: "test" });
    expect(await client.listEntities()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("findEntityByRfc encuentra una entidad más allá de la primera página", async () => {
    const pagina1 = Array.from({ length: 200 }, (_, i) => ({ id: `e${i}`, rfc: `AAA${i}` }));
    const pagina2 = [{ id: "e200", rfc: "AGO150704NA9" }];
    stubFetchPaginado([pagina1, pagina2]);

    const client = new SyntageClient({ apiKey: "test" });
    expect(await client.findEntityByRfc("ago150704na9")).toEqual({ id: "e200" });
  });

  it("listCredentials pagina igual que listEntities", async () => {
    const pagina1 = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, rfc: "X" }));
    const pagina2 = [{ id: "c200", rfc: "AMA170817NK1", status: "valid" }];
    stubFetchPaginado([pagina1, pagina2]);

    const client = new SyntageClient({ apiKey: "test" });
    const creds = await client.listCredentials();
    expect(creds).toHaveLength(201);
    expect(creds.at(-1)).toMatchObject({ id: "c200" });
  });
});
