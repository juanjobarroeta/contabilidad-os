# Satellite App Integration Guide
### How to wire an external product (credipro, bartiz, fleet, marketing, …) into contabilidad-os

**Audience:** engineers building a new satellite app that must share data, auth, and the accounting ledger with contabilidad-os.

**Precedent:** this doc generalizes the integration shipped for `bartiz` (construction management). Read [`src/app/api/construccion/*`](../src/app/api/construccion), [`src/lib/accounting/postings.ts`](../src/lib/accounting/postings.ts), and the bartiz repo for a working reference.

---

## 1. The architecture in one paragraph

**contabilidad-os is the hub.** It owns Postgres, multi-tenant auth, the general ledger, CFDI, bank reconciliation, payroll, and tax declarations. It exposes two surfaces: (a) the web UI used by accountants, authenticated via NextAuth cookies; (b) a bearer-token API used by satellite SPAs. Satellite apps are React/Vite SPAs that **have no database, no auth code, and no accounting logic** — they render UI and call HTTPS endpoints on contabilidad-os. Every satellite is gated per-Company by a `CompanyModule` row so a pure-accounting customer never sees data belonging to an add-on module they haven't contracted.

The hub–spoke diagram:

```
                        ┌──────────────────────┐
                        │   contabilidad-os    │  ← canonical hub
                        │   Next.js + Prisma   │
                        │                      │
                        │  Owns:               │
                        │   • User / Auth      │
                        │   • Company (RFC)    │
                        │   • CompanyMember    │
                        │   • Customer/Supplier│
                        │   • ChartAccount     │
                        │   • AccountingEntry  │
                        │   • Invoice (CFDI)   │
                        │   • BankAccount/Tx   │
                        │   • Employee/Payroll │
                        │   • TaxDeclaration   │
                        │   • CompanyModule    │
                        │   • CrediproLoan*    │
                        │   • Proyecto*        │
                        │   • OrdenTrabajo*    │
                        └──────────┬───────────┘
                                   │  REST + bearer JWT
              ┌────────────────────┼────────────────────┐
              │                    │                    │
      ┌───────▼────────┐  ┌────────▼────────┐  ┌────────▼────────┐
      │   credipro     │  │    bartiz       │  │ fleet-maint.    │
      │   (loans)      │  │  (construction) │  │   (future)      │
      │                │  │                 │  │                 │
      │  React SPA,    │  │  React SPA,     │  │  React SPA,     │
      │  no DB, no     │  │  no DB, no      │  │  no DB, no      │
      │  auth of its   │  │  auth of its    │  │  auth of its    │
      │  own.          │  │  own.           │  │  own.           │
      └────────────────┘  └─────────────────┘  └─────────────────┘
```

*CrediproLoan / Proyecto / OrdenTrabajo tables live inside contabilidad-os Postgres but are only populated and exposed when the corresponding `CompanyModule` is enabled.*

## 2. Non-negotiable rules

1. **One database.** The satellite app never connects to Postgres directly. There is no second schema, no cross-database sync, no eventual consistency. Everything goes over HTTPS to `contabilidad-os`.
2. **One auth system.** Users sign up and manage credentials in contabilidad-os only. The satellite has a login screen that POSTs to `/api/auth/token` and receives a bearer JWT. No separate user table.
3. **Multi-tenancy is enforced server-side.** Every API call is scoped by `companyId`, checked by `requireMembership(companyId, req)`, and further gated by `requireModule(companyId, "YOUR_MODULE")`. Never trust a `companyId` supplied by the client without running both checks.
4. **Accounting truth lives in `AccountingEntry`.** The satellite does **not** decide how to post a transaction to the books. It calls a helper in `src/lib/accounting/postings.ts` that the hub maintains. If you need a posting that doesn't exist, you add a helper — you don't write ad-hoc `accountingEntry.create` calls from satellite-owned routes.
5. **The satellite owns only its business data.** Loans (credipro), proyectos de construcción (bartiz), órdenes de trabajo (fleet). Everything else — clients, suppliers, employees, bank accounts, chart of accounts, CFDIs, tax declarations — is owned by contabilidad-os, and the satellite reads/writes them through shared endpoints (`/api/clientes`, `/api/suppliers`, `/api/bancos`, `/api/facturas`, …) rather than duplicating them.
6. **Every cross-origin call requires allowlisted CORS.** The satellite's public origin must be listed in the contabilidad-os `API_ALLOWED_ORIGINS` env var. No wildcard.

## 3. What you (the satellite team) need from contabilidad-os before you can start

Ask the contabilidad-os maintainer to complete these once per satellite:

### 3.1 Add your module enum value

In `prisma/schema.prisma`:

```prisma
enum ModuloApp {
  CONTABILIDAD
  CONSTRUCCION
  CREDIPRO       // ← added for your satellite
  FLOTA
  MARKETING
}

enum EntrySource {
  CFDI
  NOMINA
  BANCO
  MANUAL
  CONSTRUCCION
  CREDIPRO       // ← added; used by postings.ts fuente field
  FLOTA
}
```

Then `prisma db push` (dev) or `prisma migrate dev` (once migrations are formalized).

### 3.2 Add your business tables to the same schema

Example for credipro:

```prisma
// ─── Module: CrediPro — lending ──────────────────────────────────────────────
// Gated behind CompanyModule(modulo = CREDIPRO). Multi-RFC: one user can
// originate loans from any Company they're a member of, and loans are always
// scoped by companyId so cross-tenant reads are impossible.

model CrediproLoan {
  id          String   @id @default(cuid())
  companyId   String
  customerId  String?  // optional FK to the canonical Customer (the borrower)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  folio           String
  estado          LoanEstado @default(BORRADOR)
  tipo            LoanTipo   // PERSONAL | AUTO | COMERCIAL | ...
  moneda          String     @default("MXN")
  principal       Float      // amount disbursed
  tasaAnual       Float      // annual interest rate, 0.2500 = 25%
  plazoMeses      Int
  fechaDesembolso DateTime?
  fechaPrimerPago DateTime?

  // Opening fees / commissions (may be rolled into principal or cobradas aparte)
  comisionApertura Float @default(0)

  // Bank account the loan was funded from (links to contabilidad-os BankAccount)
  bankAccountId String?

  company  Company   @relation(fields: [companyId], references: [id], onDelete: Cascade)
  customer Customer? @relation(fields: [customerId], references: [id])

  schedule   LoanSchedule[]
  payments   LoanPayment[]

  @@unique([companyId, folio])
  @@index([companyId, estado])
}

enum LoanEstado {
  BORRADOR
  APROBADO
  DESEMBOLSADO
  VIGENTE
  VENCIDO
  LIQUIDADO
  CASTIGADO
  CANCELADO
}

enum LoanTipo {
  PERSONAL
  AUTO
  COMERCIAL
  HIPOTECARIO
}

// One row per scheduled installment. Created at loan approval time from
// the amortization function. Mutated as payments come in.
model LoanSchedule {
  id                 String   @id @default(cuid())
  loanId             String
  numero             Int      // 1..N
  fechaProgramada    DateTime
  saldoInicial       Float
  capital            Float
  interes            Float
  iva                Float    // IVA on the interest, when applicable
  total              Float
  saldoFinal         Float
  pagado             Boolean  @default(false)
  fechaPago          DateTime?

  loan CrediproLoan @relation(fields: [loanId], references: [id], onDelete: Cascade)

  @@unique([loanId, numero])
}

model LoanPayment {
  id           String   @id @default(cuid())
  loanId       String
  createdAt    DateTime @default(now())

  fecha        DateTime
  monto        Float
  capital      Float    // allocated to principal
  interes      Float    // allocated to interest (excl. IVA)
  ivaInteres   Float    @default(0)
  comisiones   Float    @default(0)

  // Bank reconciliation: when cobrado por transferencia
  bankTransactionId String? @unique

  loan CrediproLoan @relation(fields: [loanId], references: [id], onDelete: Cascade)
}
```

Add back-relations on `Company`, `Customer`, `BankTransaction`. Then push the schema.

### 3.3 Add a default CONTABILIDAD seed for your module's accounts

In `src/lib/accounting/postings.ts`, extend `DEFAULT_ACCOUNTS` with the SAT codes your module touches. For credipro:

```ts
{ cuentaSAT: "1120", nombre: "Cartera de crédito vigente",       tipo: "ACTIVO"  },
{ cuentaSAT: "1121", nombre: "Intereses devengados por cobrar",  tipo: "ACTIVO"  },
{ cuentaSAT: "1122", nombre: "Cartera de crédito vencida",       tipo: "ACTIVO"  },
{ cuentaSAT: "4102", nombre: "Ingresos por intereses",           tipo: "INGRESO" },
{ cuentaSAT: "4103", nombre: "Ingresos por comisiones",          tipo: "INGRESO" },
{ cuentaSAT: "5201", nombre: "Estimación preventiva de riesgos", tipo: "GASTO"   },
```

These are auto-created the first time a posting hits them — no migration needed.

### 3.4 Add posting helpers for every business event

One function per event, each obeying the posting rules:

```ts
// src/lib/accounting/postings.ts

export async function postLoanDisbursement(
  tx: Tx,
  args: {
    companyId: string
    loanId: string
    folio: string
    monto: number
    fecha: Date
  }
): Promise<void> {
  await postBalancedEntry(tx, {
    companyId: args.companyId,
    fecha: args.fecha,
    descripcion: `Desembolso préstamo ${args.folio}`,
    monto: args.monto,
    fuente: "CREDIPRO",
    referencia: args.loanId,
    referenciaTipo: "LOAN_DISBURSEMENT",
    cargo: { cuentaSAT: "1120" },  // Cartera vigente
    abono: { cuentaSAT: "1101" },  // Bancos
  })
}

export async function postLoanPayment(
  tx: Tx,
  args: {
    companyId: string
    paymentId: string
    loanFolio: string
    capital: number
    interes: number
    ivaInteres: number
    fecha: Date
  }
): Promise<void> {
  // 4-leg posting: DR Bancos / CR Cartera + CR Ingresos intereses + CR IVA
  // Emit directly via createMany (not via postBalancedEntry since it's 4 rows).
  // Pattern: same shape as postEstimacionTimbrada in the existing file.
}

export async function postLoanInterestAccrual(
  tx: Tx,
  args: {
    companyId: string
    loanId: string
    loanFolio: string
    interes: number
    fecha: Date
  }
): Promise<void> {
  await postBalancedEntry(tx, {
    companyId: args.companyId,
    fecha: args.fecha,
    descripcion: `Devengo de intereses préstamo ${args.loanFolio}`,
    monto: args.interes,
    fuente: "CREDIPRO",
    referencia: args.loanId,
    referenciaTipo: "LOAN_ACCRUAL",
    cargo: { cuentaSAT: "1121" },  // Intereses devengados
    abono: { cuentaSAT: "4102" },  // Ingresos por intereses
  })
}
```

**Rules every posting helper obeys (repeat until memorized):**
1. Balanced (Σ cargo = Σ abono per call).
2. Accepts `tx` from the caller's `prisma.$transaction` — never opens its own.
3. Always sets `fuente` + `referenciaTipo` for drill-back.
4. Idempotency is the caller's job — the state machine on the source row prevents double-posting.
5. Writes `year` + `month` alongside `fecha` so monthly reporting filters are cheap.

### 3.5 Add the CORS matcher entry

In `src/middleware.ts`:

```ts
export const config = {
  matcher: [
    "/api/auth/token",
    "/api/companies/:path*",
    "/api/construccion/:path*",
    "/api/credipro/:path*",    // ← added
  ],
}
```

### 3.6 Update `API_ALLOWED_ORIGINS` on Railway

Append the satellite's public Vercel URL:

```
API_ALLOWED_ORIGINS=https://bartiz.vercel.app,https://credipro.vercel.app,http://localhost:5173
```

No spaces, no trailing slashes. Save → Railway redeploys → CORS picks it up.

### 3.7 Enable `CREDIPRO` on at least one test Company

Via SQL, Prisma Studio, or a one-off script (copy `scripts/backfill-modules.mjs`):

```ts
await prisma.companyModule.upsert({
  where: { companyId_modulo: { companyId: TEST_COMPANY_ID, modulo: "CREDIPRO" } },
  create: { companyId: TEST_COMPANY_ID, modulo: "CREDIPRO" },
  update: { habilitado: true },
})
```

## 4. The API contract the satellite consumes

### 4.1 Login

```
POST /api/auth/token
Content-Type: application/json

{ "email": "juan@example.com", "password": "…" }
```

**Response 200:**
```json
{
  "token": "<7-day HS256 JWT>",
  "user": { "id": "…", "email": "…", "name": "…" },
  "companies": [
    {
      "id": "cmxxx…",
      "rfc": "SMP150917L69",
      "razonSocial": "Soluciones de Movilidad Poblana SAPI de CV",
      "role": "OWNER",
      "modulos": ["CONTABILIDAD", "CREDIPRO"]
    },
    {
      "id": "cmyyy…",
      "rfc": "XAXX010101000",
      "razonSocial": "Segunda Empresa SA de CV",
      "role": "ADMIN",
      "modulos": ["CONTABILIDAD"]
    }
  ]
}
```

**Multi-RFC lending implication:** a user who belongs to two companies, both with CREDIPRO enabled, sees both in the `companies[]` array. The satellite's empresa selector lets them switch between originating loans from company A (`SMP150917L69`) or company B. Every subsequent API call includes `companyId=<active>` in the query string or JSON body, and the hub's `requireMembership(companyId, req)` enforces that the user actually belongs to that company.

### 4.2 Every data endpoint follows the same pattern

```
GET  /api/credipro/loans?companyId=<cmxxx>
POST /api/credipro/loans
GET  /api/credipro/loans/[id]
POST /api/credipro/loans/[id]/disburse
POST /api/credipro/loans/[id]/payment
```

All protected with:

```ts
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url)
  const companyId = searchParams.get("companyId")
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 })

  await requireMembership(companyId, undefined, req)  // req makes it bearer-aware
  await requireModule(companyId, "CREDIPRO")

  const loans = await prisma.crediproLoan.findMany({
    where: { companyId },
    include: { customer: { select: { id: true, razonSocial: true, rfc: true } } },
    orderBy: { createdAt: "desc" },
  })
  return NextResponse.json(loans)
})
```

All POST/PUT/PATCH endpoints use `requireWriter(companyId, req)` which excludes the `VIEWER` role.

### 4.3 The proof flow — disbursement end-to-end

Build this first. It exercises schema + auth + module gate + postings in one request. Everything else is easier once this passes.

```ts
// src/app/api/credipro/loans/[id]/disburse/route.ts
import { NextResponse } from "next/server"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz"
import { postLoanDisbursement } from "@/lib/accounting/postings"

const disburseSchema = z.object({
  bankAccountId: z.string().min(1),
  fecha: z.string().datetime().optional(),
})

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params
    const body = await req.json().catch(() => ({}))
    const parsed = disburseSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
    }
    const fecha = parsed.data.fecha ? new Date(parsed.data.fecha) : new Date()

    const loan = await prisma.crediproLoan.findUnique({
      where: { id },
      select: { id: true, companyId: true, folio: true, estado: true, principal: true },
    })
    if (!loan) throw new AuthzError(404, "Préstamo no encontrado")

    await requireWriter(loan.companyId, req)
    await requireModule(loan.companyId, "CREDIPRO")

    if (loan.estado !== "APROBADO") {
      return NextResponse.json(
        { error: `Solo se pueden desembolsar préstamos APROBADOS (estado actual: ${loan.estado})` },
        { status: 422 }
      )
    }

    const bank = await prisma.bankAccount.findUnique({
      where: { id: parsed.data.bankAccountId },
      select: { id: true, companyId: true },
    })
    if (!bank || bank.companyId !== loan.companyId) {
      return NextResponse.json({ error: "Cuenta bancaria inválida" }, { status: 400 })
    }

    // Atomic: bank tx + ledger pair + loan state transition
    const result = await prisma.$transaction(async (tx) => {
      const bankTx = await tx.bankTransaction.create({
        data: {
          companyId: loan.companyId,
          bankAccountId: bank.id,
          fecha,
          descripcion: `Desembolso préstamo ${loan.folio}`,
          referencia: loan.folio,
          monto: -Math.abs(loan.principal),
          tipo: "DEBITO",
          status: "MATCHED",
          source: "UPLOAD",
          notes: `Generado por credipro: loan ${loan.id}`,
        },
      })

      await postLoanDisbursement(tx, {
        companyId: loan.companyId,
        loanId: loan.id,
        folio: loan.folio,
        monto: loan.principal,
        fecha,
      })

      const updated = await tx.crediproLoan.update({
        where: { id: loan.id },
        data: {
          estado: "DESEMBOLSADO",
          fechaDesembolso: fecha,
          bankAccountId: bank.id,
        },
      })

      return { loan: updated, bankTransactionId: bankTx.id }
    })

    return NextResponse.json(result)
  }
)
```

### 4.4 Validation script (do this before touching the frontend)

Create `scripts/validate-credipro-postings.mjs` by copying `scripts/validate-construccion-postings.mjs` and swapping the calls. It should:

1. Pick a Company with CREDIPRO enabled (or create + enable one)
2. Ensure a BankAccount exists
3. Insert a test loan in `APROBADO` state
4. Open `prisma.$transaction` and run the same logic as the disburse endpoint
5. Read back the `AccountingEntry` rows and assert: 2 rows, Σ CARGO = Σ ABONO, `fuente = CREDIPRO`, `referenciaTipo = LOAN_DISBURSEMENT`, accounts are 1120/1101
6. Clean up unless `KEEP=1`

Running this against the live dev DB with `node scripts/validate-credipro-postings.mjs` proves the business logic is correct independent of HTTP/CORS/auth. **Do not ship the frontend until this script passes.**

## 5. The satellite frontend (React/Vite)

### 5.1 Scaffold

```bash
npm create vite@latest credipro -- --template react
cd credipro
npm install react-router-dom
```

### 5.2 The five files

Copy from bartiz and modify. These are the only files needed for the auth + HTTP layer.

#### `src/config/api.js`

```js
const API_URL =
  import.meta.env.VITE_API_URL?.replace(/\/$/, '') ||
  'http://localhost:3000'

const TOKEN_KEY = 'credipro.token'  // must be unique per satellite

export const tokenStorage = {
  get:   () => { try { return localStorage.getItem(TOKEN_KEY) } catch { return null } },
  set:   (t) => { try { localStorage.setItem(TOKEN_KEY, t) } catch {} },
  clear: ()  => { try { localStorage.removeItem(TOKEN_KEY) } catch {} },
}

export const api = (endpoint) => {
  const clean = endpoint.startsWith('/') ? endpoint : `/${endpoint}`
  return `${API_URL}${clean}`
}

export async function apiFetch(path, opts = {}) {
  const { method = 'GET', body, headers = {}, skipAuth = false } = opts
  const finalHeaders = { Accept: 'application/json', ...headers }
  if (body !== undefined) finalHeaders['Content-Type'] = 'application/json'
  if (!skipAuth) {
    const token = tokenStorage.get()
    if (token) finalHeaders.Authorization = `Bearer ${token}`
  }

  const res = await fetch(api(path), {
    method,
    headers: finalHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  let data = null
  const text = await res.text()
  if (text) { try { data = JSON.parse(text) } catch { data = text } }

  if (!res.ok) {
    if (res.status === 401 && !skipAuth) {
      tokenStorage.clear()
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.href = '/login'
      }
    }
    const err = new Error((data && data.error) || `Request failed: ${res.status}`)
    err.status = res.status
    err.data = data
    throw err
  }

  return data
}
```

#### `src/auth/AuthContext.jsx`

```jsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { apiFetch, tokenStorage } from '../config/api'

const PREFERRED_MODULE = 'CREDIPRO'  // ← per satellite
const USER_KEY       = 'credipro.user'
const COMPANIES_KEY  = 'credipro.companies'
const ACTIVE_KEY     = 'credipro.activeCompanyId'

const AuthContext = createContext(null)

function readJson(key) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null } catch { return null }
}
function writeJson(key, value) {
  try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)) } catch {}
}

export function AuthProvider({ children }) {
  const [user, setUser]               = useState(() => readJson(USER_KEY))
  const [companies, setCompanies]     = useState(() => readJson(COMPANIES_KEY) ?? [])
  const [activeCompanyId, setActive]  = useState(() => { try { return localStorage.getItem(ACTIVE_KEY) } catch { return null } })
  const [booting, setBooting]         = useState(true)

  useEffect(() => {
    const token = tokenStorage.get()
    if (!token || !user || !companies.length) { tokenStorage.clear(); setBooting(false); return }
    setBooting(false)
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const login = useCallback(async ({ email, password }) => {
    const data = await apiFetch('/api/auth/token', {
      method: 'POST',
      body: { email, password },
      skipAuth: true,
    })
    tokenStorage.set(data.token)
    writeJson(USER_KEY, data.user)
    writeJson(COMPANIES_KEY, data.companies)
    setUser(data.user)
    setCompanies(data.companies)

    const preferred = data.companies.find((c) => c.modulos?.includes(PREFERRED_MODULE))
    const pick = preferred ?? data.companies[0]
    if (pick) { localStorage.setItem(ACTIVE_KEY, pick.id); setActive(pick.id) }
    return data
  }, [])

  const logout = useCallback(() => {
    tokenStorage.clear()
    localStorage.removeItem(ACTIVE_KEY)
    writeJson(USER_KEY, null)
    writeJson(COMPANIES_KEY, null)
    setUser(null); setCompanies([]); setActive(null)
  }, [])

  const selectCompany = useCallback((id) => {
    localStorage.setItem(ACTIVE_KEY, id); setActive(id)
  }, [])

  const activeCompany = useMemo(
    () => companies.find((c) => c.id === activeCompanyId) ?? null,
    [companies, activeCompanyId]
  )

  const value = useMemo(
    () => ({ user, companies, activeCompany, activeCompanyId, isAuthenticated: !!user, booting, login, logout, selectCompany }),
    [user, companies, activeCompany, activeCompanyId, booting, login, logout, selectCompany]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
```

#### `src/pages/Login.jsx`

Standard email+password form. On submit call `useAuth().login({email, password})`. On success, check `data.companies.some(c => c.modulos.includes('CREDIPRO'))` and block if none — show "Ninguna de tus empresas tiene el módulo CrediPro habilitado." Otherwise `navigate('/', { replace: true })`.

#### `src/App.jsx`

Wrap the tree in `<AuthProvider>`, guard all routes except `/login` behind a `<RequireAuth>` component that redirects unauthenticated users.

#### `src/components/Layout.jsx`

Sidebar with an empresa selector at the top driven by `useAuth().companies.filter(c => c.modulos.includes('CREDIPRO'))`. Only show pages you've actually built (`ported: true` flag pattern from bartiz).

### 5.3 Every page follows the same template

```jsx
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { apiFetch } from '../config/api'

export default function Loans() {
  const { activeCompany } = useAuth()
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const cargar = useCallback(async () => {
    if (!activeCompany?.id) return
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch(`/api/credipro/loans?companyId=${activeCompany.id}`)
      setItems(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [activeCompany?.id])

  useEffect(() => { cargar() }, [cargar])

  // ... render
}
```

## 6. Deployment

### 6.1 Required env vars

| Variable | Project | Value | Notes |
|---|---|---|---|
| `VITE_API_URL` | credipro (Vercel) | `https://contabilidad-os-production.up.railway.app` | Vite bakes env at build time — must redeploy with cleared cache |
| `API_ALLOWED_ORIGINS` | contabilidad-os (Railway) | `https://credipro.vercel.app,http://localhost:5173` | Comma-separated, no spaces, no trailing slash, exact scheme+host |

### 6.2 Smoke test sequence (run in order, each must pass before moving on)

```bash
# 1. Validation script passes locally → business logic correct
cd contabilidad-os
set -a; . ./.env.local; set +a
node scripts/validate-credipro-postings.mjs
# Expected: "✅ All checks passed"

# 2. CORS preflight from your satellite origin → 204
curl -s -o /dev/null -w "preflight %{http_code}\n" -X OPTIONS \
  https://contabilidad-os-production.up.railway.app/api/auth/token \
  -H "Origin: https://credipro.vercel.app" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type"
# Expected: preflight 204

# 3. Route exists, rejects bad creds → 401 (not 404)
curl -s -o /dev/null -w "login %{http_code}\n" -X POST \
  https://contabilidad-os-production.up.railway.app/api/auth/token \
  -H "Content-Type: application/json" \
  -d '{"email":"no@no.no","password":"no"}'
# Expected: login 401

# 4. Open satellite, login with real credentials, create one loan, see it persist
```

Only skip step 1 if you're already certain the schema + postings are correct from a previous session. Steps 2 and 3 are the two most common failure points (env var typo, trailing slash, middleware matcher missing).

## 7. Failure mode decoder

| Symptom | Almost certainly | Fix |
|---|---|---|
| `preflight 403` | Your origin is not in `API_ALLOWED_ORIGINS` | Check value character-by-character: exact scheme, no trailing slash, no spaces around commas, no quotes wrapping the string |
| `login 404` | The satellite is calling the wrong host (its own instead of contabilidad-os) | `VITE_API_URL` is unset or wasn't baked into the Vite build. Redeploy Vercel with cleared build cache |
| `login 401` on correct credentials | Wrong password, or user was created in a different environment | Log in via the contabilidad-os web UI first to confirm the creds work |
| `403 Módulo CREDIPRO no contratado` | Active company lacks a `CompanyModule(modulo=CREDIPRO)` row | Run the enable script for that specific `companyId` |
| `403 Sin acceso a esta empresa` | User is not a member of the companyId being sent | Bug in the satellite: likely sending a `companyId` the user doesn't belong to. Check the `activeCompanyId` in localStorage |
| `500` on `/disburse` (or your proof flow) | Posting helper is trying to read a ChartAccount that doesn't exist and isn't in `DEFAULT_ACCOUNTS` | Add the SAT code to `DEFAULT_ACCOUNTS` in postings.ts |
| Ledger not balanced on `validate-credipro-postings.mjs` | You emitted an unbalanced posting | Check the cargo/abono totals in your helper; if it's a 3+ leg posting, emit directly via `createMany` instead of `postBalancedEntry` |
| Login works but every subsequent call is 401 | Token was signed with a different secret | Both services must share `AUTH_SECRET` (or `NEXTAUTH_SECRET`). Confirm both repos read from the same env var |

## 8. What the satellite team must **not** do

1. **Do not create a second database.** Ever.
2. **Do not implement auth.** Use `/api/auth/token`.
3. **Do not duplicate contabilidad-os native UI.** Users manage clientes, suppliers, bank accounts, CFDIs, tax declarations, users, and the chart of accounts in contabilidad-os. Link out from the satellite, don't rebuild.
4. **Do not post to `AccountingEntry` directly from a satellite-owned route.** Use a helper in `postings.ts`. If one doesn't exist, add it.
5. **Do not trust `companyId` from the client without `requireMembership + requireModule`.** Both are cheap and both are required.
6. **Do not skip `req` in authz calls on routes meant to be called by the satellite.** Without `req`, the route falls back to NextAuth cookie auth, which cross-origin clients don't have.
7. **Do not store the bearer token anywhere except `localStorage` (or equivalent secure store).** Never in a cookie, never in the URL, never logged.
8. **Do not embed the bearer token in SSR** — if your satellite uses Next.js or any SSR framework, the token is browser-side only, never sent to the satellite's own server.
9. **Do not share the secret.** `AUTH_SECRET` belongs to contabilidad-os. Satellites never see it. They only see the JWT the hub issues.

## 9. Long-term considerations (not urgent for v1)

- **Token rotation.** Current expiry is 7 days with no refresh endpoint. If a user is active for longer, they re-log in. Add a `POST /api/auth/token/refresh` endpoint when this becomes annoying. Not worth building pre-launch.
- **Nightly cron jobs.** Accrual of interest, aging of cartera, generating IVA reports. Each is a system-call route (`/api/credipro/jobs/*`) protected by a shared secret header rather than a user JWT. Schedule via Railway cron, Vercel cron, or an external scheduler.
- **CONDUSEF / SOFOM ENR reporting.** Separate report endpoints, query-heavy, PDF/XLS export. Defer until regulatory deadline forces it.
- **Event bus.** If a satellite needs to react to events that happen in contabilidad-os (e.g. "bank transaction was reconciled → mark the LoanPayment as cleared"), today you poll. When this becomes painful, add an outbox table + webhook dispatcher — don't bolt on Kafka.
- **Multi-region.** Everything is in one Railway region today. If latency becomes an issue for customers outside Mexico, split reads/writes. Not a v1 concern.

---

## 10. Reference implementation checklist

When wiring a new satellite, check off each item as you complete it. This list is the minimum viable integration.

**Hub-side (contabilidad-os):**
- [ ] `ModuloApp` enum extended with your module name
- [ ] `EntrySource` enum extended with your module name
- [ ] Business tables added to `prisma/schema.prisma` with `companyId` FK
- [ ] Back-relations added to `Company` (and `Customer`, `BankTransaction` if applicable)
- [ ] `prisma db push` run against dev DB; verify with `prisma studio`
- [ ] `DEFAULT_ACCOUNTS` in `postings.ts` extended with any new SAT codes
- [ ] Posting helper function added for every business event
- [ ] At least one endpoint built and secured with `requireMembership + requireModule + req`
- [ ] Proof-flow endpoint (`/disburse`, `/pay`, whatever closes the ledger loop) built inside `prisma.$transaction`
- [ ] `src/middleware.ts` matcher extended with `/api/your-module/:path*`
- [ ] `API_ALLOWED_ORIGINS` env var on Railway updated
- [ ] Validation script written and **passing**
- [ ] At least one test Company has the module enabled
- [ ] Pushed to main, Railway deploy green, curl smoke tests pass

**Satellite-side:**
- [ ] Vite + React + react-router-dom scaffolded
- [ ] Five files (api.js, AuthContext.jsx, Login.jsx, App.jsx, Layout.jsx) copied from bartiz and tweaked
- [ ] Per-satellite `TOKEN_KEY` and localStorage keys changed
- [ ] `PREFERRED_MODULE` in AuthContext set to your module name
- [ ] Login page blocks users whose companies don't have your module
- [ ] Sidebar shows only `ported: true` items
- [ ] At least one real page calling one real endpoint
- [ ] `.env.example` documenting `VITE_API_URL`
- [ ] Deployed to Vercel
- [ ] `VITE_API_URL` env var set and **redeployed with cleared build cache**
- [ ] End-to-end smoke test: login → create one business entity → verify row in contabilidad-os Postgres

When all boxes are checked, the integration is complete.

---

**Questions that are out of scope for this document:**
- How to design your satellite's schema (that's business modeling, not integration)
- How to build specific pages (that's standard React work)
- How to write amortization / scheduling / reporting logic (that's domain-specific)
- How to test in isolation (write unit tests for pure functions; use the validation script for posting helpers; rely on the real DB for integration tests)

**Questions that are in scope:**
- How does auth work? → §4.1 + the bearer-token endpoint
- How do I scope data by company? → §2 rule 3 + §4.2 pattern
- How does accounting get posted? → §3.4 posting helpers + §4.3 proof flow
- How do I deploy? → §6
- How do I debug? → §7 failure mode decoder
- What am I forbidden from doing? → §8
