# UX redesign roadmap

**Branch:** `codex/ux-redesign`

**Purpose:** preserve approved UX decisions and prototypes until the fiscal/SAT Phase 0 work is stable.

**Production UI changes:** none on this branch.

## Delivery order

The authenticated product audit refined the original page list into this workflow sequence:

1. Foundation contracts
2. Onboarding and Empresa
3. Inicio and Cartera
4. Cierre mensual
5. Bancos
6. Nómina
7. Fiscal y contable
8. Secondary operations and settings

The active redesign is **Inicio and Cartera**. It proves page hierarchy, company and period context, source freshness, role-shaped actions, status language, and one canonical work queue before those contracts are used by Cierre mensual, Bancos, and compliance. The next prototype after this one is **Cierre mensual**.

## Shared-component strategy

The redesign is not a sequence of isolated page skins. Each page prototype must declare which shared contracts it consumes or introduces.

| Contract | First proving surface | Later consumers |
|---|---|---|
| Page shell and header | Dashboard | Every primary route |
| Company context | Dashboard | Banking, compliance, company settings |
| Period context | Dashboard | Taxes, accounting, compliance |
| Field and validation | Onboarding | Company settings, banking, payroll |
| Credential upload | Onboarding | Company settings, invoicing |
| Versioned consent | Onboarding | Credential changes, regulated features |
| Step workflow | Onboarding | Accounting close, declarations |
| Plan and payment summary | Onboarding | Billing and company administration |
| Status, source, and freshness | Dashboard | Taxes, compliance, accounting, banking |
| Responsive workbench and table | Bank reconciliation | Invoices, payroll, records |
| Loading, empty, error, permission | Dashboard | Every data surface |

## Implementation rules

- Inspect and extend `src/components/ui` before creating a new primitive.
- Keep route files focused on data and workflow composition.
- Put reusable business-aware patterns in shared workflow components.
- Require two named consumers before generalizing a business component.
- Keep fiscal status semantic: `unknown`, `estimated`, `ready`, `presented`, and `verified` are not interchangeable visual colors.
- All visible application copy is Spanish for Mexico.
- No emoji characters are permitted in application UI.
- Account, role, invitation, company, and subscription context are inferred by the server rather than requested from the user.
- Each implementation PR owns one primary route and includes desktop, mobile, keyboard, loading, empty, error, and permission evidence.

## Branch policy

This branch stores discovery documents and inspectable prototypes. After fiscal stabilization, production work should move through small page-scoped branches. Shared-component extraction belongs in the first page that proves the component, followed immediately by adoption in the second named consumer; it should not become a separate full-app rewrite.
