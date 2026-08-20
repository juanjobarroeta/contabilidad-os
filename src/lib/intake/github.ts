import { githubRepoForProduct, productByKey, INTAKE_TZ } from "./config";
import type { AskConRelaciones } from "./telegram";

// ─────────────────────────────────────────────────────────────────────────────
// Capa GitHub: creación de issues (REST) y tablero Projects v2 (GraphQL — no
// tiene equivalente REST). El issue lleva la metadata de origen y la cita
// verbatim del cliente: cuando el trabajo se retome semanas después, las
// palabras exactas están a un click.
// ─────────────────────────────────────────────────────────────────────────────

const API = "https://api.github.com";

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.INTAKE_GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

/** Cuerpo del issue con metadata de origen. Puro y testeado. */
export function renderIssueBody(ask: AskConRelaciones, extra?: { mrrNote?: string }): string {
  const lines: string[] = [ask.body, ""];
  if (ask.quote) {
    lines.push("> " + ask.quote.replace(/\n/g, "\n> "), "");
  }
  lines.push("---", "**Origen**");
  const fuente: string[] = [];
  if (ask.contact?.displayName || ask.contact?.phoneE164) {
    fuente.push(`- Contacto: ${ask.contact.displayName ?? ""} ${ask.contact.phoneE164 ?? ""}`.trim());
  }
  if (ask.transcript) {
    const cuando = ask.transcript.startedAt
      ? new Intl.DateTimeFormat("es-MX", { timeZone: INTAKE_TZ, dateStyle: "medium", timeStyle: "short" }).format(ask.transcript.startedAt)
      : "";
    fuente.push(`- Zoom: "${ask.transcript.meetingTopic ?? ""}" ${cuando}`.trim());
    if (ask.quoteTsSec != null) {
      fuente.push(`- Momento en la grabación: ${Math.floor(ask.quoteTsSec / 60)}m${ask.quoteTsSec % 60}s`);
    }
  } else {
    fuente.push("- Canal: WhatsApp");
  }
  if (ask.confidence != null) fuente.push(`- Confianza de extracción: ${ask.confidence.toFixed(2)}`);
  if (extra?.mrrNote) fuente.push(`- ${extra.mrrNote}`);
  fuente.push(`- Intake ask: \`${ask.id}\``);
  lines.push(...fuente);
  return lines.join("\n");
}

export async function createIssueForAsk(
  ask: AskConRelaciones,
  extra?: { mrrNote?: string }
): Promise<{ url: string; nodeId: string }> {
  const repo = githubRepoForProduct(ask.product);
  if (!repo) throw new Error("INTAKE_GITHUB_REPO no configurado");
  const labels = ["intake"];
  if (ask.product) labels.push(`product:${ask.product}`);
  labels.push(`kind:${ask.kind.toLowerCase()}`);

  const res = await fetch(`${API}/repos/${repo}/issues`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ title: ask.title, body: renderIssueBody(ask, extra), labels }),
  });
  if (!res.ok) throw new Error(`GitHub issues ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { html_url: string; node_id: string };

  // Tablero Projects v2 (opcional): agrega el issue; los campos custom se
  // llenan a mano / por el scoring semanal.
  if (process.env.INTAKE_GITHUB_PROJECT_ID) {
    try {
      await addIssueToProject(json.node_id);
    } catch (e) {
      console.error("[intake] addIssueToProject failed", e instanceof Error ? e.message : e);
    }
  }
  return { url: json.html_url, nodeId: json.node_id };
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null;
  if (!res.ok || !json || json.errors?.length) {
    throw new Error(`GitHub GraphQL: ${json?.errors?.map((e) => e.message).join("; ") ?? res.status}`);
  }
  return json.data as T;
}

export async function addIssueToProject(issueNodeId: string): Promise<string> {
  const data = await graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
    `mutation($project: ID!, $content: ID!) {
       addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
     }`,
    { project: process.env.INTAKE_GITHUB_PROJECT_ID, content: issueNodeId }
  );
  return data.addProjectV2ItemById.item.id;
}

export type ProjectItem = {
  itemId: string;
  issueNodeId: string | null;
  issueUrl: string | null;
  title: string;
  state: string | null;
  /** Campos custom por nombre → valor numérico o texto. */
  fields: Record<string, number | string | boolean>;
};

/** Lee los items del tablero con sus campos (paginado). */
export async function listProjectItems(): Promise<ProjectItem[]> {
  const projectId = process.env.INTAKE_GITHUB_PROJECT_ID;
  if (!projectId) return [];
  const items: ProjectItem[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const data: {
      node: {
        items: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: {
            id: string;
            content: { __typename: string; id?: string; url?: string; title?: string; state?: string } | null;
            fieldValues: {
              nodes: {
                __typename: string;
                number?: number;
                text?: string;
                name?: string;
                field?: { name?: string };
              }[];
            };
          }[];
        };
      } | null;
    } = await graphql(
      `query($project: ID!, $cursor: String) {
         node(id: $project) {
           ... on ProjectV2 {
             items(first: 100, after: $cursor) {
               pageInfo { hasNextPage endCursor }
               nodes {
                 id
                 content {
                   __typename
                   ... on Issue { id url title state }
                 }
                 fieldValues(first: 20) {
                   nodes {
                     __typename
                     ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
                     ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
                     ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
                   }
                 }
               }
             }
           }
         }
       }`,
      { project: projectId, cursor }
    );
    const conn = data.node?.items;
    if (!conn) break;
    for (const n of conn.nodes) {
      const fields: Record<string, number | string | boolean> = {};
      for (const fv of n.fieldValues.nodes) {
        const fname = fv.field?.name;
        if (!fname) continue;
        if (typeof fv.number === "number") fields[fname] = fv.number;
        else if (typeof fv.text === "string") fields[fname] = fv.text;
        else if (typeof fv.name === "string") fields[fname] = fv.name;
      }
      items.push({
        itemId: n.id,
        issueNodeId: n.content?.id ?? null,
        issueUrl: n.content?.url ?? null,
        title: n.content?.title ?? "(sin título)",
        state: n.content?.state ?? null,
        fields,
      });
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return items;
}

/** Escribe un campo numérico (p. ej. "Score") de un item del tablero. */
export async function setProjectNumberField(itemId: string, fieldId: string, value: number): Promise<void> {
  await graphql(
    `mutation($project: ID!, $item: ID!, $field: ID!, $value: Float!) {
       updateProjectV2ItemFieldValue(
         input: { projectId: $project, itemId: $item, fieldId: $field, value: { number: $value } }
       ) { projectV2Item { id } }
     }`,
    { project: process.env.INTAKE_GITHUB_PROJECT_ID, item: itemId, field: fieldId, value }
  );
}

/** MRR del contacto vía Stripe (para "MRR at risk" en bugs). Best-effort. */
export async function mrrNoteForAsk(ask: AskConRelaciones): Promise<string | undefined> {
  const customerId = ask.contact?.stripeCustomerId;
  if (!customerId || !process.env.STRIPE_SECRET_KEY || ask.kind !== "BUG") return undefined;
  try {
    const { getStripe } = await import("@/lib/billing/stripe");
    const stripe = getStripe();
    if (!stripe) return undefined;
    const subs = await stripe.subscriptions.list({ customer: customerId, status: "active", limit: 10 });
    let mensualCent = 0;
    for (const s of subs.data) {
      for (const item of s.items.data) {
        const price = item.price;
        if (!price?.unit_amount || !price.recurring) continue;
        const porCiclo = price.unit_amount * (item.quantity ?? 1);
        mensualCent += price.recurring.interval === "year" ? porCiclo / 12 : porCiclo;
      }
    }
    if (mensualCent > 0) {
      const cur = subs.data[0]?.currency?.toUpperCase() ?? "MXN";
      return `MRR del contacto (Stripe): ${(mensualCent / 100).toFixed(0)} ${cur}/mes`;
    }
  } catch (e) {
    console.error("[intake] mrr lookup failed", e instanceof Error ? e.message : e);
  }
  return undefined;
}

/** ¿El repo del producto existe y las credenciales sirven? — para gatear el approve. */
export function githubReady(product: string | null): boolean {
  return Boolean(process.env.INTAKE_GITHUB_TOKEN && githubRepoForProduct(product));
}

export function coreMultiplierForProduct(product: string | null): number {
  return productByKey(product)?.core ? 3.0 : 1.0;
}
