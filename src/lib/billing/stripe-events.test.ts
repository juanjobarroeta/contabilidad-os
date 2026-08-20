import { describe, expect, it } from "vitest";
import type { CompanyPlan, SubscriptionStatus } from "@prisma/client";
import {
  applyStripeEvent,
  extractPeriodEnd,
  mapStripeStatus,
  type BillingRepo,
} from "./stripe-events";
import type { PlanFacturable } from "./planes-stripe";

// ── mapStripeStatus ──────────────────────────────────────────────────────────

describe("mapStripeStatus", () => {
  it("active y trialing → ACTIVE", () => {
    expect(mapStripeStatus("active")).toBe("ACTIVE");
    expect(mapStripeStatus("trialing")).toBe("ACTIVE");
  });

  it("past_due → PAST_DUE", () => {
    expect(mapStripeStatus("past_due")).toBe("PAST_DUE");
  });

  it("canceled, unpaid e incomplete_expired → CANCELED", () => {
    expect(mapStripeStatus("canceled")).toBe("CANCELED");
    expect(mapStripeStatus("unpaid")).toBe("CANCELED");
    expect(mapStripeStatus("incomplete_expired")).toBe("CANCELED");
  });

  it("estados transitorios o desconocidos → null (sin cambio)", () => {
    expect(mapStripeStatus("incomplete")).toBeNull();
    expect(mapStripeStatus("paused")).toBeNull();
    expect(mapStripeStatus("")).toBeNull();
  });
});

// ── extractPeriodEnd ─────────────────────────────────────────────────────────

describe("extractPeriodEnd", () => {
  const epoch = 1_767_225_600; // 2026-01-01T00:00:00Z

  it("lee current_period_end del objeto suscripción (API clásica)", () => {
    expect(extractPeriodEnd({ current_period_end: epoch })).toEqual(new Date(epoch * 1000));
  });

  it("cae a items.data[].current_period_end (API 2025+)", () => {
    const sub = { items: { data: [{ current_period_end: epoch }, { current_period_end: epoch - 100 }] } };
    expect(extractPeriodEnd(sub)).toEqual(new Date(epoch * 1000));
  });

  it("null si no hay periodo en ninguna forma", () => {
    expect(extractPeriodEnd({})).toBeNull();
    expect(extractPeriodEnd({ items: { data: [] } })).toBeNull();
  });
});

// ── applyStripeEvent ─────────────────────────────────────────────────────────

type UserRow = {
  id: string;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  subscriptionStatus?: SubscriptionStatus;
  currentPeriodEnd?: Date;
};

function fakeRepo(users: UserRow[]) {
  const planesAplicados: Array<{ userId: string; plan: PlanFacturable; tier: CompanyPlan }> = [];
  const repo: BillingRepo = {
    async userIdById(id) {
      return users.find((u) => u.id === id)?.id ?? null;
    },
    async userIdByStripeCustomer(customerId) {
      return users.find((u) => u.stripeCustomerId === customerId)?.id ?? null;
    },
    async userIdBySubscription(subscriptionId) {
      return users.find((u) => u.stripeSubscriptionId === subscriptionId)?.id ?? null;
    },
    async updateUserBilling(userId, data) {
      const u = users.find((x) => x.id === userId);
      if (!u) throw new Error("user no existe");
      Object.assign(u, data);
    },
    async setPlanEmpresas(userId, plan, tier) {
      planesAplicados.push({ userId, plan, tier });
    },
  };
  return { repo, users, planesAplicados };
}

const evento = (type: string, object: Record<string, unknown>) => ({ type, data: { object } });

describe("applyStripeEvent — checkout.session.completed", () => {
  it("activa la suscripción, guarda ids de Stripe y aplica el plan a las empresas", async () => {
    const { repo, users, planesAplicados } = fakeRepo([{ id: "user_1" }]);

    const r = await applyStripeEvent(
      evento("checkout.session.completed", {
        mode: "subscription",
        customer: "cus_123",
        subscription: "sub_456",
        client_reference_id: "user_1",
        metadata: { userId: "user_1", plan: "PROFESIONAL" },
      }),
      repo,
    );

    expect(r.handled).toBe(true);
    expect(users[0]).toMatchObject({
      subscriptionStatus: "ACTIVE",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_456",
    });
    expect(planesAplicados).toEqual([{ userId: "user_1", plan: "PROFESIONAL", tier: "PRO" }]);
  });

  it("resuelve por stripeCustomerId cuando no hay metadata de usuario", async () => {
    const { repo, users } = fakeRepo([{ id: "user_2", stripeCustomerId: "cus_abc" }]);

    const r = await applyStripeEvent(
      evento("checkout.session.completed", { customer: "cus_abc", subscription: "sub_x" }),
      repo,
    );

    expect(r.handled).toBe(true);
    expect(users[0].subscriptionStatus).toBe("ACTIVE");
    expect(users[0].stripeSubscriptionId).toBe("sub_x");
  });

  it("usuario desconocido → no manejado (la ruta responde 200 y sólo loguea)", async () => {
    const { repo, planesAplicados } = fakeRepo([]);
    const r = await applyStripeEvent(
      evento("checkout.session.completed", { customer: "cus_nadie", metadata: { plan: "BASICO" } }),
      repo,
    );
    expect(r.handled).toBe(false);
    expect(planesAplicados).toEqual([]);
  });
});

describe("applyStripeEvent — customer.subscription.updated", () => {
  it("past_due → PAST_DUE y actualiza currentPeriodEnd", async () => {
    const { repo, users } = fakeRepo([
      { id: "user_1", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", subscriptionStatus: "ACTIVE" },
    ]);
    const epoch = 1_770_000_000;

    const r = await applyStripeEvent(
      evento("customer.subscription.updated", {
        id: "sub_1",
        customer: "cus_1",
        status: "past_due",
        current_period_end: epoch,
      }),
      repo,
    );

    expect(r.handled).toBe(true);
    expect(users[0].subscriptionStatus).toBe("PAST_DUE");
    expect(users[0].currentPeriodEnd).toEqual(new Date(epoch * 1000));
  });

  it("active → ACTIVE; encuentra al usuario por customer si aún no tiene sub id", async () => {
    const { repo, users } = fakeRepo([
      { id: "user_1", stripeCustomerId: "cus_1", subscriptionStatus: "PAST_DUE" },
    ]);

    const r = await applyStripeEvent(
      evento("customer.subscription.updated", { id: "sub_9", customer: "cus_1", status: "active" }),
      repo,
    );

    expect(r.handled).toBe(true);
    expect(users[0].subscriptionStatus).toBe("ACTIVE");
    expect(users[0].stripeSubscriptionId).toBe("sub_9"); // se adopta el sub id
  });

  it("estado transitorio (incomplete) no cambia el status", async () => {
    const { repo, users } = fakeRepo([
      { id: "user_1", stripeSubscriptionId: "sub_1", subscriptionStatus: "ACTIVE" },
    ]);

    await applyStripeEvent(
      evento("customer.subscription.updated", { id: "sub_1", status: "incomplete" }),
      repo,
    );

    expect(users[0].subscriptionStatus).toBe("ACTIVE");
  });

  it("cambio de cantidad de una suscripción sigue mapeando status y periodo", async () => {
    // Un customer.subscription.updated puede traer quantity y price en
    // items.data (cualquier cambio de partidas lo dispara). El webhook debe
    // seguir mapeando el status y leer current_period_end de los items sin
    // tropezar con los campos extra.
    const { repo, users, planesAplicados } = fakeRepo([
      { id: "user_1", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", subscriptionStatus: "PAST_DUE" },
    ]);
    const epoch = 1_770_000_000;

    const r = await applyStripeEvent(
      evento("customer.subscription.updated", {
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        items: {
          data: [
            {
              id: "si_1",
              quantity: 14,
              price: { id: "price_despacho_789" },
              current_period_end: epoch,
            },
          ],
        },
      }),
      repo,
    );

    expect(r.handled).toBe(true);
    expect(users[0].subscriptionStatus).toBe("ACTIVE");
    expect(users[0].currentPeriodEnd).toEqual(new Date(epoch * 1000));
    // El evento de cantidad NO re-aplica planes a empresas (eso sólo pasa en checkout).
    expect(planesAplicados).toEqual([]);
  });

  it("suscripción desconocida → no manejado", async () => {
    const { repo } = fakeRepo([]);
    const r = await applyStripeEvent(
      evento("customer.subscription.updated", { id: "sub_x", customer: "cus_x", status: "active" }),
      repo,
    );
    expect(r.handled).toBe(false);
  });
});

describe("applyStripeEvent — customer.subscription.deleted", () => {
  it("marca CANCELED aunque Stripe reporte otro status en el objeto", async () => {
    const { repo, users } = fakeRepo([
      { id: "user_1", stripeSubscriptionId: "sub_1", subscriptionStatus: "ACTIVE" },
    ]);

    const r = await applyStripeEvent(
      evento("customer.subscription.deleted", { id: "sub_1", customer: "cus_1", status: "canceled" }),
      repo,
    );

    expect(r.handled).toBe(true);
    expect(users[0].subscriptionStatus).toBe("CANCELED");
  });
});

describe("applyStripeEvent — invoice.payment_failed", () => {
  it("marca PAST_DUE por stripeCustomerId", async () => {
    const { repo, users } = fakeRepo([
      { id: "user_1", stripeCustomerId: "cus_1", subscriptionStatus: "ACTIVE" },
    ]);

    const r = await applyStripeEvent(
      evento("invoice.payment_failed", { customer: "cus_1" }),
      repo,
    );

    expect(r.handled).toBe(true);
    expect(users[0].subscriptionStatus).toBe("PAST_DUE");
  });

  it("cliente desconocido → no manejado, sin escrituras", async () => {
    const { repo } = fakeRepo([]);
    const r = await applyStripeEvent(evento("invoice.payment_failed", { customer: "cus_x" }), repo);
    expect(r.handled).toBe(false);
  });
});

describe("applyStripeEvent — otros", () => {
  it("eventos no manejados → handled=false", async () => {
    const { repo } = fakeRepo([]);
    const r = await applyStripeEvent(evento("charge.succeeded", {}), repo);
    expect(r.handled).toBe(false);
  });

  it("acepta campos expandidos ({ id }) en customer/subscription", async () => {
    const { repo, users } = fakeRepo([{ id: "user_1", stripeCustomerId: "cus_1" }]);
    const r = await applyStripeEvent(
      evento("checkout.session.completed", {
        customer: { id: "cus_1" },
        subscription: { id: "sub_2" },
      }),
      repo,
    );
    expect(r.handled).toBe(true);
    expect(users[0].stripeSubscriptionId).toBe("sub_2");
  });
});
