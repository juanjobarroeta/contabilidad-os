// ─── Belvo Open Banking Integration ──────────────────────────────────────────
// Connects to Mexican banks via Belvo API to auto-import transactions.
//
// Env vars:
//   BELVO_SECRET_ID       — from Belvo dashboard
//   BELVO_SECRET_PASSWORD — from Belvo dashboard
//   BELVO_ENV             — "sandbox" (default) or "production"
//
// Flow:
//   1. Frontend opens Belvo Connect Widget → user authenticates with bank
//   2. Widget returns a Link ID → stored on BankAccount
//   3. Backend calls GET /api/transactions → creates BankTransaction rows
// ─────────────────────────────────────────────────────────────────────────────

const BELVO_URLS: Record<string, string> = {
  sandbox: "https://sandbox.belvo.com",
  production: "https://api.belvo.com",
};

function getBaseUrl(): string {
  const env = process.env.BELVO_ENV ?? "sandbox";
  return BELVO_URLS[env] ?? BELVO_URLS.sandbox;
}

function getAuth(): string {
  const id = process.env.BELVO_SECRET_ID;
  const pw = process.env.BELVO_SECRET_PASSWORD;
  if (!id || !pw) throw new Error("Belvo no configurado: faltan BELVO_SECRET_ID y BELVO_SECRET_PASSWORD");
  return "Basic " + Buffer.from(`${id}:${pw}`).toString("base64");
}

export function isBelvoConfigured(): boolean {
  return !!(process.env.BELVO_SECRET_ID && process.env.BELVO_SECRET_PASSWORD);
}

async function belvoFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Authorization": getAuth(),
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Belvo ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ─── Create Access Token for Connect Widget ──────────────────────────────────
// The widget needs a temporary token to initialize. Call this from the backend,
// return the token to the frontend.
export async function createWidgetToken(linkId?: string): Promise<{ access: string }> {
  const body: Record<string, unknown> = {
    id: process.env.BELVO_SECRET_ID,
    password: process.env.BELVO_SECRET_PASSWORD,
    scopes: "read_institutions,write_links,read_links",
  };
  if (linkId) body.link_id = linkId;

  return belvoFetch("/api/token/", { method: "POST", body: JSON.stringify(body) });
}

// ─── Links ───────────────────────────────────────────────────────────────────
export interface BelvoLink {
  id: string;
  institution: string;
  access_mode: string;
  status: string;
  created_at: string;
}

export async function getLink(linkId: string): Promise<BelvoLink> {
  return belvoFetch(`/api/links/${linkId}/`);
}

// ─── Sandbox: create a link without the Connect Widget ────────────────────────
// SANDBOX ONLY. Creates a link directly against a Belvo test institution with
// test credentials, so we can exercise the full accounts → transactions →
// reconciliation flow before wiring the real Connect Widget. Production links
// MUST come from the widget (real user consent) — this throws outside sandbox.
//
// Belvo MX sandbox test institution + users are shown in your Belvo dashboard;
// the common retail one is "erebor_mx_retail" with user "bnk100" / "full".
export async function createSandboxLink(opts?: {
  institution?: string;
  username?: string;
  password?: string;
}): Promise<BelvoLink> {
  if ((process.env.BELVO_ENV ?? "sandbox") !== "sandbox") {
    throw new Error("createSandboxLink sólo está permitido en BELVO_ENV=sandbox");
  }
  return belvoFetch("/api/links/", {
    method: "POST",
    body: JSON.stringify({
      institution: opts?.institution ?? "erebor_mx_retail",
      username: opts?.username ?? "bnk100",
      password: opts?.password ?? "full",
      access_mode: "single",
    }),
  });
}

// ─── Accounts ────────────────────────────────────────────────────────────────
export interface BelvoAccount {
  id: string;
  link: string;
  institution: { name: string };
  name: string;
  number: string;
  type: string; // "checking", "savings", "credit_card", etc.
  currency: string;
  balance: { current: number; available: number };
}

export async function listAccounts(linkId: string): Promise<BelvoAccount[]> {
  const data = await belvoFetch<{ results: BelvoAccount[] }>(
    `/api/accounts/?link=${linkId}`
  );
  return data.results ?? [];
}

// ─── Transactions ────────────────────────────────────────────────────────────
export interface BelvoTransaction {
  id: string;
  account: { id: string };
  collected_at: string;
  value_date: string;
  accounting_date: string;
  amount: number; // positive = credit, negative = debit
  balance: number;
  description: string;
  reference: string | null;
  type: string; // "INFLOW" | "OUTFLOW"
  status: string;
  category: string | null;
  subcategory: string | null;
  merchant: { name: string } | null;
}

export async function listTransactions(
  linkId: string,
  dateFrom: string,  // YYYY-MM-DD
  dateTo: string,    // YYYY-MM-DD
  accountId?: string
): Promise<BelvoTransaction[]> {
  const params = new URLSearchParams({
    link: linkId,
    date_from: dateFrom,
    date_to: dateTo,
  });
  if (accountId) params.set("account", accountId);

  // Belvo paginates — collect all pages
  const all: BelvoTransaction[] = [];
  let url: string | null = `/api/transactions/?${params}`;

  while (url) {
    const page: { results: BelvoTransaction[]; next: string | null } = await belvoFetch(url);
    all.push(...(page.results ?? []));
    if (page.next) {
      const nextUrl = new URL(page.next);
      url = nextUrl.pathname + nextUrl.search;
    } else {
      url = null;
    }
  }

  return all;
}

// ─── Institutions (for displaying bank logos/names) ──────────────────────────
export interface BelvoInstitution {
  id: number;
  name: string;
  display_name: string;
  country_codes: string[];
  type: string;
  logo: string | null;
}

export async function listInstitutions(country: string = "MX"): Promise<BelvoInstitution[]> {
  const data = await belvoFetch<{ results: BelvoInstitution[] }>(
    `/api/institutions/?country_code=${country}`
  );
  return data.results ?? [];
}
