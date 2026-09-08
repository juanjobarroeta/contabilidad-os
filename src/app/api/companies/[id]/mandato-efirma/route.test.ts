import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: { id: "user-1", email: "accountant@example.test" },
  membership: {
    id: "member-1",
    role: "ACCOUNTANT",
    allowedModules: [] as string[],
    accessViaDespacho: false,
  },
  company: {
    isActive: true,
    fielCer: "enc:v1:certificate",
    fielKey: "enc:v1:private-key",
    fielPassword: "enc:v1:password",
  } as {
    isActive: boolean;
    fielCer: string | null;
    fielKey: string | null;
    fielPassword: string | null;
  } | null,
  acceptances: [] as Array<{ userId: string }>,
  existing: null as null | { id: string },
  locked: [{ id: "company-1" }] as Array<{ id: string }>,
  registered: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  membershipCalls: [] as Array<{ hasRequest: boolean }>,
  transactionCalls: 0,
}));

vi.mock("@/lib/authz", () => {
  class AuthzError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  }
  return {
    AuthzError,
    requireMembership: vi.fn(async (
      _companyId: string,
      allowedRoles?: string[],
      req?: Request,
    ) => {
      state.membershipCalls.push({ hasRequest: Boolean(req) });
      if (allowedRoles && !allowedRoles.includes(state.membership.role)) {
        throw new AuthzError(403, "Sin permisos suficientes");
      }
      return { user: state.user, membership: state.membership };
    }),
    withAuthz:
      (handler: (...args: never[]) => Promise<Response>) =>
      async (...args: never[]) => {
        try {
          return await handler(...args);
        } catch (error) {
          if (error instanceof AuthzError) {
            return Response.json({ error: error.message }, { status: error.status });
          }
          throw error;
        }
      },
  };
});

vi.mock("@/lib/audit", () => ({ ipDeRequest: () => "203.0.113.10" }));

vi.mock("@/lib/legal/aceptaciones", () => ({
  registrarAceptaciones: vi.fn(async (params: Record<string, unknown>) => {
    state.registered.push(params);
  }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    company: { findUnique: vi.fn(async () => state.company) },
    legalAcceptance: { findMany: vi.fn(async () => state.acceptances) },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => {
      state.transactionCalls += 1;
      const tx = {
        $queryRaw: vi.fn(async () => state.locked),
        company: { findUnique: vi.fn(async () => state.company) },
        legalAcceptance: { findFirst: vi.fn(async () => state.existing) },
        legalAcceptanceCreate: vi.fn(),
        auditLog: {
          create: vi.fn(async (entry: { data: Record<string, unknown> }) => {
            state.audits.push(entry.data);
            return { id: "audit-1" };
          }),
        },
      };
      return callback(tx);
    }),
  },
}));

import { MANDATO_EFIRMA } from "@/lib/legal/documentos";
import { estadoCredencialParaMandato } from "@/lib/legal/mandato-efirma";
import { GET, POST } from "./route";

const context = { params: Promise.resolve({ id: "company-1" }) };

function post(body: unknown, contentType = "application/json") {
  return new Request(
    "https://app.example.test/api/companies/company-1/mandato-efirma",
    {
      method: "POST",
      headers: { "content-type": contentType },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  state.user = { id: "user-1", email: "accountant@example.test" };
  state.membership = {
    id: "member-1",
    role: "ACCOUNTANT",
    allowedModules: [],
    accessViaDespacho: false,
  };
  state.company = {
    isActive: true,
    fielCer: "enc:v1:certificate",
    fielKey: "enc:v1:private-key",
    fielPassword: "enc:v1:password",
  };
  state.acceptances = [];
  state.existing = null;
  state.locked = [{ id: "company-1" }];
  state.registered = [];
  state.audits = [];
  state.membershipCalls = [];
  state.transactionCalls = 0;
});

describe("existing e.firma mandate", () => {
  it("classifies missing, partial, plaintext, and encrypted credential sets", () => {
    expect(estadoCredencialParaMandato({
      fielCer: null,
      fielKey: null,
      fielPassword: null,
    })).toBe("SIN_EFIRMA");
    expect(estadoCredencialParaMandato({
      fielCer: "enc:v1:certificate",
      fielKey: null,
      fielPassword: null,
    })).toBe("INCOMPLETA");
    expect(estadoCredencialParaMandato({
      fielCer: "certificate",
      fielKey: "private-key",
      fielPassword: "password",
    })).toBe("REQUIERE_REENCRIPTACION");
    expect(estadoCredencialParaMandato(state.company!)).toBe("LISTA");
  });

  it("shows a viewer the missing mandate without granting acceptance", async () => {
    state.membership = {
      id: "viewer-1",
      role: "VIEWER",
      allowedModules: [],
      accessViaDespacho: false,
    };
    const response = await GET(new Request("https://app.example.test"), context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      vigente: false,
      estadoCredencial: "LISTA",
      puedeAceptar: false,
      role: "VIEWER",
      version: MANDATO_EFIRMA.version,
    });
    expect(state.membershipCalls).toEqual([{ hasRequest: true }]);
  });

  it("rejects viewers, platform operators, and module-restricted staff", async () => {
    state.membership = {
      id: "viewer-1",
      role: "VIEWER",
      allowedModules: [],
      accessViaDespacho: false,
    };
    let response = await POST(post({
      acepta: true,
      version: MANDATO_EFIRMA.version,
    }), context);
    expect(response.status).toBe(403);
    expect(state.transactionCalls).toBe(0);

    state.membership = {
      id: "operador:user-1:company-1",
      role: "OWNER",
      allowedModules: [],
      accessViaDespacho: false,
    };
    response = await POST(post({
      acepta: true,
      version: MANDATO_EFIRMA.version,
    }), context);
    expect(response.status).toBe(403);
    expect(state.transactionCalls).toBe(0);

    state.membership = {
      id: "vertical-1",
      role: "ACCOUNTANT",
      allowedModules: ["PURIFICADORA"],
      accessViaDespacho: false,
    };
    response = await POST(post({
      acepta: true,
      version: MANDATO_EFIRMA.version,
    }), context);
    expect(response.status).toBe(403);
    expect(state.transactionCalls).toBe(0);
  });

  it("honors unrestricted despacho authority over a restricted direct row", async () => {
    state.membership = {
      id: "direct-restricted-1",
      role: "ACCOUNTANT",
      allowedModules: ["PURIFICADORA"],
      accessViaDespacho: true,
    };

    const response = await POST(post({
      acepta: true,
      version: MANDATO_EFIRMA.version,
    }), context);

    expect(response.status).toBe(200);
    expect(state.registered).toHaveLength(1);
  });

  it("uses only the interactive session for acceptance", async () => {
    const response = await POST(post({
      acepta: true,
      version: MANDATO_EFIRMA.version,
    }), context);

    expect(response.status).toBe(200);
    expect(state.membershipCalls).toEqual([{ hasRequest: false }]);
  });

  it("requires the exact current acknowledgement body", async () => {
    for (const body of [
      { acepta: false, version: MANDATO_EFIRMA.version },
      { acepta: true, version: "2020-01-01" },
      { acepta: true, version: MANDATO_EFIRMA.version, extra: true },
    ]) {
      const response = await POST(post(body), context);
      expect(response.status).toBe(400);
    }
    expect(state.transactionCalls).toBe(0);
  });

  it("atomically records acceptance and a metadata-only audit", async () => {
    const response = await POST(post({
      acepta: true,
      version: MANDATO_EFIRMA.version,
    }), context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, alreadyAccepted: false });
    expect(state.registered).toHaveLength(1);
    expect(state.registered[0]).toMatchObject({
      userId: state.user.id,
      companyId: "company-1",
      documentos: ["MANDATO_EFIRMA"],
      contexto: "credencial_existente",
    });
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      accion: "legal.mandato-efirma-aceptar-existente",
      detalle: {
        documento: "MANDATO_EFIRMA",
        version: MANDATO_EFIRMA.version,
        credentialState: "ENCRYPTED_COMPLETE",
        authMethod: "SESSION_COOKIE",
      },
    });
    expect(JSON.stringify(state.audits)).not.toContain("enc:v1");
  });

  it("fails closed for non-encrypted credentials and is idempotent per user", async () => {
    state.company = {
      isActive: true,
      fielCer: "certificate",
      fielKey: "private-key",
      fielPassword: "password",
    };
    let response = await POST(post({
      acepta: true,
      version: MANDATO_EFIRMA.version,
    }), context);
    expect(response.status).toBe(409);
    expect(state.registered).toHaveLength(0);
    expect(state.audits).toHaveLength(0);

    state.company = {
      isActive: true,
      fielCer: "enc:v1:certificate",
      fielKey: "enc:v1:private-key",
      fielPassword: "enc:v1:password",
    };
    state.existing = { id: "acceptance-1" };
    response = await POST(post({
      acepta: true,
      version: MANDATO_EFIRMA.version,
    }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ alreadyAccepted: true });
    expect(state.registered).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });
});
