import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
import { createHash } from "node:crypto";

// ─── Mock de prisma.apiRefreshToken con almacén en memoria ─────────────────
// Implementa lo mínimo que usa el SUT: create / findUnique / update /
// updateMany / findMany, con los filtros exactos que emplea el módulo.

type Row = {
  id: string;
  tokenHash: string;
  userId: string;
  etiqueta: string;
  scope: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedById: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  ip: string | null;
};

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  seq: 0,
}));

vi.mock("./prisma", () => {
  const find = (where: { id?: string; tokenHash?: string }) =>
    (state.rows as Row[]).find(
      (r) =>
        (where.id !== undefined && r.id === where.id) ||
        (where.tokenHash !== undefined && r.tokenHash === where.tokenHash)
    ) ?? null;
  return {
    prisma: {
      apiRefreshToken: {
        create: async ({ data }: { data: Partial<Row> }) => {
          const row: Row = {
            id: `tok${++state.seq}`,
            tokenHash: data.tokenHash!,
            userId: data.userId!,
            etiqueta: data.etiqueta!,
            scope: data.scope ?? null,
            expiresAt: data.expiresAt!,
            revokedAt: null,
            replacedById: null,
            lastUsedAt: null,
            createdAt: new Date(),
            ip: data.ip ?? null,
          };
          state.rows.push(row);
          return { ...row };
        },
        findUnique: async ({
          where,
        }: {
          where: { id?: string; tokenHash?: string };
        }) => {
          const r = find(where);
          return r ? { ...r } : null;
        },
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<Row>;
        }) => {
          const r = find(where);
          if (!r) throw new Error("registro no encontrado");
          Object.assign(r, data);
          return { ...r };
        },
        updateMany: async ({
          where,
          data,
        }: {
          where: { userId: string; revokedAt: null; id?: string };
          data: Partial<Row>;
        }) => {
          const objetivo = (state.rows as Row[]).filter(
            (r) =>
              r.userId === where.userId &&
              r.revokedAt === null &&
              (where.id === undefined || r.id === where.id)
          );
          for (const r of objetivo) Object.assign(r, data);
          return { count: objetivo.length };
        },
        findMany: async ({
          where,
        }: {
          where: { userId: string; revokedAt: null; expiresAt: { gt: Date } };
        }) =>
          (state.rows as Row[])
            .filter(
              (r) =>
                r.userId === where.userId &&
                r.revokedAt === null &&
                r.expiresAt.getTime() > where.expiresAt.gt.getTime()
            )
            .map((r) => ({ ...r })),
      },
    },
  };
});

import {
  emitirRefreshToken,
  generarSecretoRefresh,
  hashRefreshToken,
  listarRefreshTokensActivos,
  revocarRefreshTokens,
  rotarRefreshToken,
  REFRESH_TOKEN_EXPIRY_SECONDS,
} from "./api-refresh-token";

const filas = () => state.rows as Row[];

beforeEach(() => {
  state.rows.length = 0;
  state.seq = 0;
});

describe("hashRefreshToken / generarSecretoRefresh", () => {
  it("el hash es el SHA-256 hex del secreto (determinista)", () => {
    const secreto = "abc123";
    const esperado = createHash("sha256").update(secreto).digest("hex");
    expect(hashRefreshToken(secreto)).toBe(esperado);
    expect(hashRefreshToken(secreto)).toBe(hashRefreshToken(secreto));
    expect(hashRefreshToken(secreto)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("secretos distintos producen hashes distintos y con entropía suficiente", () => {
    const a = generarSecretoRefresh();
    const b = generarSecretoRefresh();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40); // 32 bytes base64url ≈ 43 chars
    expect(hashRefreshToken(a)).not.toBe(hashRefreshToken(b));
  });
});

describe("emitirRefreshToken", () => {
  it("persiste SOLO el hash (nunca el secreto) con vigencia de 30 días", async () => {
    const antes = Date.now();
    const emitido = await emitirRefreshToken({
      userId: "u1",
      etiqueta: "bartiz-construccion",
      scope: "clientes facturas",
      ip: "1.2.3.4",
    });

    expect(filas()).toHaveLength(1);
    const fila = filas()[0];
    expect(fila.tokenHash).toBe(hashRefreshToken(emitido.refreshToken));
    expect(fila.tokenHash).not.toContain(emitido.refreshToken);
    expect(fila.scope).toBe("clientes facturas");
    expect(fila.etiqueta).toBe("bartiz-construccion");
    const esperadoMs = antes + REFRESH_TOKEN_EXPIRY_SECONDS * 1000;
    expect(Math.abs(fila.expiresAt.getTime() - esperadoMs)).toBeLessThan(5000);
  });
});

describe("rotarRefreshToken — rotación normal", () => {
  it("emite secreto nuevo, revoca el anterior y lo encadena con replacedById", async () => {
    const { refreshToken } = await emitirRefreshToken({
      userId: "u1",
      etiqueta: "padel",
      scope: "clientes",
    });

    const res = await rotarRefreshToken(refreshToken, { ip: "9.9.9.9" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.refreshToken).not.toBe(refreshToken);
    expect(res.userId).toBe("u1");
    expect(res.scope).toBe("clientes"); // el scope se hereda en la rotación

    const vieja = filas()[0];
    const nueva = filas()[1];
    expect(vieja.revokedAt).toBeInstanceOf(Date);
    expect(vieja.replacedById).toBe(nueva.id);
    expect(vieja.lastUsedAt).toBeInstanceOf(Date);
    expect(nueva.revokedAt).toBeNull();
    expect(nueva.etiqueta).toBe("padel");

    // El secreto nuevo sí rota; el flujo continúa con normalidad.
    const res2 = await rotarRefreshToken(res.refreshToken);
    expect(res2.ok).toBe(true);
  });
});

describe("rotarRefreshToken — detección de robo (reuso)", () => {
  it("reusar un token ya rotado revoca la CADENA COMPLETA y regresa motivo reuso", async () => {
    const { refreshToken: t1 } = await emitirRefreshToken({
      userId: "u1",
      etiqueta: "zionx",
    });
    const r1 = await rotarRefreshToken(t1);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = await rotarRefreshToken(r1.refreshToken);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    // El atacante presenta t1 (ya rotado dos generaciones atrás).
    const robo = await rotarRefreshToken(t1);
    expect(robo.ok).toBe(false);
    if (robo.ok) return;
    expect(robo.motivo).toBe("reuso");
    expect(robo.userId).toBe("u1");
    expect(robo.etiqueta).toBe("zionx");

    // TODA la cadena quedó revocada, incluido el token vigente del portador legítimo.
    for (const fila of filas()) expect(fila.revokedAt).toBeInstanceOf(Date);

    // El secreto más reciente ya no sirve: también se reporta como reuso.
    const legitimo = await rotarRefreshToken(r2.refreshToken);
    expect(legitimo.ok).toBe(false);
    if (!legitimo.ok) expect(legitimo.motivo).toBe("reuso");
  });

  it("un token revocado manualmente también dispara reuso al presentarse", async () => {
    const { refreshToken } = await emitirRefreshToken({
      userId: "u1",
      etiqueta: "flotagob",
    });
    await revocarRefreshTokens({ userId: "u1", todos: true });

    const res = await rotarRefreshToken(refreshToken);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.motivo).toBe("reuso");
  });
});

describe("rotarRefreshToken — expiración y desconocidos", () => {
  it("token expirado regresa motivo expirado sin rotar", async () => {
    const { refreshToken } = await emitirRefreshToken({
      userId: "u1",
      etiqueta: "padel",
    });
    filas()[0].expiresAt = new Date(Date.now() - 1000); // forzar vencimiento

    const res = await rotarRefreshToken(refreshToken);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.motivo).toBe("expirado");
    expect(filas()).toHaveLength(1); // no se creó sustituto
  });

  it("secreto desconocido regresa motivo desconocido", async () => {
    const res = await rotarRefreshToken("secreto-que-no-existe");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.motivo).toBe("desconocido");
  });
});

describe("revocarRefreshTokens / listarRefreshTokensActivos", () => {
  it("revoca uno por id, todos con todos:true, y nunca tokens ajenos", async () => {
    const a = await emitirRefreshToken({ userId: "u1", etiqueta: "a" });
    await emitirRefreshToken({ userId: "u1", etiqueta: "b" });
    await emitirRefreshToken({ userId: "u2", etiqueta: "ajeno" });

    // u2 no puede revocar el token de u1 aunque conozca el id.
    expect(await revocarRefreshTokens({ userId: "u2", tokenId: a.id })).toBe(0);

    expect(await revocarRefreshTokens({ userId: "u1", tokenId: a.id })).toBe(1);
    expect(await listarRefreshTokensActivos("u1")).toHaveLength(1);

    expect(await revocarRefreshTokens({ userId: "u1", todos: true })).toBe(1);
    expect(await listarRefreshTokensActivos("u1")).toHaveLength(0);

    // El token de u2 sigue intacto.
    expect(await listarRefreshTokensActivos("u2")).toHaveLength(1);
  });

  it("sin id y sin todos:true no revoca nada", async () => {
    await emitirRefreshToken({ userId: "u1", etiqueta: "a" });
    expect(await revocarRefreshTokens({ userId: "u1" })).toBe(0);
  });
});
