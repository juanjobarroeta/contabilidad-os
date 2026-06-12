// Auditor — the 24/7 contador. Contract: docs/fiscal-brain-contract.md
export * from "./types";
export { CHECKS } from "./checks";
export { listChecks, auditar } from "./run";
export { toCfdiNormalizado, type InvoiceLike, type InvoiceItemLike } from "./from-prisma";
