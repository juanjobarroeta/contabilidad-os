import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/cron-scheduler", () => ({ kickCron: vi.fn() }));
vi.mock("@/lib/cierre/compuerta-contabilizacion", () => ({ evaluarCompuertaContabilizacion: async () => ({ ok: true }), invalidarCompuertaContabilizacion: vi.fn() }));
const A = "itest-statement-review", B = "itest-statement-other", U = "itest-statement-owner", V = "itest-statement-viewer";
let actor = U;
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: actor } }) }));
vi.mock("@/lib/subscription", () => ({ gateEscritura: async () => null }));
import { lookupMovementCep } from "../cep-enriquecer";
import { stageBankOriginal, readBankOriginal } from "./inbox";
import { prisma } from "@/lib/prisma";
import { persistStatementTransactions } from "./ingest";
import { accountReview, previewReview, executeReview, statementPostingGate, documentPage, type ReviewOperation } from "./review";
import { DELETE } from "@/app/api/bancos/transactions/[txId]/route";
import { deshacerLoteImportado } from "../undo-import";
import { POST } from "@/app/api/bancos/statement-review/route";
import { executeBankStatementTool } from "@/lib/ai/bank-statement-executor";
import { executeChatPendingAction, getChatPendingAction } from "@/lib/ai/pending-action";
import { seedChartOfAccounts } from "@/lib/contabilidad/seed-catalog";
import { aprobarSugerencia } from "../sugerencias-concepto";
import { cerrarEjercicio } from "@/lib/contabilidad/candado";
import { postMonth } from "@/lib/contabilidad/posting";
import type { ParsedTransaction } from "@/lib/bank-parser";
const scope = { companyId: A, bankAccountId: A + "-bank", year: 2025, month: 9 };
const row = (amount: number, id?: string, date = "2025-09-15"): ParsedTransaction => ({ fecha: new Date(date + "T12:00:00Z"), monto: amount, descripcion: "Synthetic bank movement", ...(id ? { bankReferenceId: id } : {}) });
async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { companyId: { in: [A,B] } } });
  await prisma.bankTransaction.deleteMany({ where: { companyId: { in: [A,B] } } });
  await prisma.company.deleteMany({ where: { id: { in: [A,B] } } });
  await prisma.user.deleteMany({ where: { id: { in: [U,V] } } });
}
async function ingest(name: string, transactions: ParsedTransaction[], extra: Record<string, unknown> = {}) {
  return persistStatementTransactions({ ...scope, transactions, periodo: "2025-09", archivo: { bytes: Buffer.from(name), nombre: name, mime: "text/csv" }, ...extra });
}
async function prepared(operation: ReviewOperation, s = scope) { const review = await accountReview(s); const request = { ...s, expected: review.hash, operation }; const preview = await previewReview(request); return { ...request, effectExpected: preview.effectHash }; }
async function verify(batchId: string, amounts: number[], s = scope) {
  const credits = amounts.filter(n=>n>0).reduce((a,b)=>a+b,0), debits = -amounts.filter(n=>n<0).reduce((a,b)=>a+b,0);
  return executeReview(await prepared({ type: "verify", batchId, opening: 10000, closing: 10000+credits-debits, credits, debits,
    creditCount: amounts.filter(n=>n>0).length, debitCount: amounts.filter(n=>n<0).length, countsUnavailable: false,
    periodStart: "2025-09-01", periodEnd: "2025-09-30", accountConfirmed: true, coverageConfirmed: true, originalReviewed: true, reason: "Synthetic original controls reviewed" }, s), U);
}

describe.skipIf(process.env.DB_TESTS_SKIP === "1")("statement evidence against Postgres", () => {
  beforeEach(async () => {
    await cleanup(); actor = U;
    await prisma.user.createMany({ data: [{ id: U, email: "statement-owner@test.invalid" },{id: V,email:"statement-viewer@test.invalid"}] });
    await prisma.company.createMany({ data: [A,B].map((id,i)=>({id,rfc:`BST25010${i}AA1`,razonSocial:id,regimenFiscal:"601",codigoPostal:"06600"})) });
    await prisma.companyMember.createMany({ data: [{companyId:A,userId:U,role:"OWNER"},{companyId:A,userId:V,role:"VIEWER"}] });
    await seedChartOfAccounts(A);
    await prisma.bankAccount.create({ data: { id: scope.bankAccountId, companyId:A,banco:"Synthetic",nombre:"Review test",numeroCuenta:"00001234" } });
    await prisma.chatConversation.create({ data: { id:A+"-chat",companyId:A,userId:U,visibility:"COMPANY" } });
  });
  afterAll(cleanup);
  it("serializes concurrent replay and retains equal legitimate occurrences", async () => {
    const rows = [{...row(-100),hora:"09:01"},{...row(-100),hora:"09:03"}];
    const results = await Promise.all([ingest("same.csv",rows),ingest("same.csv",rows)]);
    expect(results.map(r=>r.imported).sort()).toEqual([0,2]);
    expect(new Set(results.map(r=>r.batchId)).size).toBe(1);
    const review = await accountReview(scope);
    expect(review.movements).toHaveLength(2); expect(review.duplicates).toHaveLength(0); expect(review.documents[0].rows).toHaveLength(2);
    expect(await prisma.accountingEntry.count({where:{companyId:A}})).toBe(0);
  });
  it("retains a zero-new final document, verifies full controls and invalidates when evidence changes", async () => {
    await ingest("interim.csv",[row(200,"credit"),row(-100,"debit")]);
    const final = await ingest("final.pdf",[row(200,"credit"),row(-100,"debit")],{source:"UPLOAD_PDF"});
    expect(final).toMatchObject({imported:0,skipped:2,pending:0});
    expect((await prisma.importBatch.findUniqueOrThrow({where:{id:final.batchId}})).archivoPdf?.length).toBeGreaterThan(0);
    await verify(final.batchId,[200,-100]); expect((await statementPostingGate(A,2025,9)).ok).toBe(true);
    await ingest("late.csv",[row(50,"late-credit"),row(-50,"late-debit")]);
    expect((await accountReview(scope)).status).toBe("CHANGED");
    expect((await statementPostingGate(A,2025,9)).ok).toBe(false);
    await expect(postMonth({companyId:A,year:2025,month:9})).rejects.toThrow(/verificar/);
    const page = documentPage(await accountReview(scope),final.batchId);expect(page.uncoveredCount).toBe(2);
  });
  it("does not accept a net-balanced extraction with missing debit and credit totals", async () => {
    const doc = await ingest("incomplete.pdf",[row(100,"a"),row(-100,"b")]);
    const op: ReviewOperation = {type:"verify",batchId:doc.batchId,opening:1000,closing:1000,credits:200,debits:200,creditCount:2,debitCount:2,countsUnavailable:false,periodStart:"2025-09-01",periodEnd:"2025-09-30",accountConfirmed:true,coverageConfirmed:true,originalReviewed:true,reason:"Printed totals mismatch extraction"};
    await expect(prepared(op)).rejects.toThrow(/abonos/);
    expect((await accountReview(scope)).verified).toBeNull();
  });
  it("asks on overlapping amount/date, remembers keep-both and refuses a stale decision", async () => {
    await ingest("first.csv",[row(-100)]); await ingest("partial.csv",[row(-100)]);
    const review=await accountReview(scope);expect(review.unresolved).toHaveLength(1);
    const request=await prepared({type:"row",rowId:review.unresolved[0].id,resolution:"NEW",reason:"User confirms a separate real payment"});
    await executeReview(request,U);expect((await accountReview(scope)).duplicates).toHaveLength(0);
    await expect(executeReview(request,U)).rejects.toThrow(/cambió/);
    expect(await prisma.bankTransaction.count({where:{companyId:A}})).toBe(2);
  });
  it("supports a changed bank ID date across month boundaries without silently overwriting history", async () => {
    await ingest("sep.csv",[row(-100,"moved","2025-09-30")]);
    const next=await ingest("oct.csv",[row(-110,"moved","2025-10-01")],{periodo:"2025-10"});expect(next.pending).toBe(1);
    const s={...scope,month:10},review=await accountReview(s),old=review.candidates[0];
    await executeReview(await prepared({type:"row",rowId:review.unresolved[0].id,movementId:old.id,resolution:"REPLACE",reason:"Final statement corrects amount and operation date"},s),U);
    const updated=await accountReview(s);expect(updated.movements).toHaveLength(1);expect(Number(updated.movements[0].monto)).toBe(-110);
    expect((await accountReview(scope)).movements).toHaveLength(0);
    expect(await prisma.bankTransactionTombstone.count({where:{companyId:A}})).toBe(1);
  });
  it("keeps original posted entries plus exact reversals and rejects an unseen ledger effect", async () => {
    await ingest("ocr-duplicate.pdf",[row(-100),row(-100)]);
    const review=await accountReview(scope),[primary,secondary]=review.movements;
    const accounts=await prisma.chartAccount.findMany({where:{companyId:A},take:2});
    await prisma.accountingEntry.createMany({data:accounts.map((a,i)=>({companyId:A,chartAccountId:a.id,year:2025,month:9,fecha:secondary.fecha,monto:100,tipo:i===0?"CARGO":"ABONO",fuente:"BANCO",referencia:secondary.id,referenciaTipo:"BANK_TX",descripcion:"Synthetic original"}))});
    const op:ReviewOperation={type:"pair",primaryId:primary.id,secondaryId:secondary.id,resolution:"MERGE",reason:"Original shows one row repeated by extraction"};
    const old=await prepared(op);
    await prisma.accountingEntry.updateMany({where:{companyId:A,referencia:secondary.id},data:{monto:110}});
    await expect(executeReview(old,U)).rejects.toThrow(/efecto contable/);
    const request=await prepared(op);await executeReview(request,U);
    const entries=await prisma.accountingEntry.findMany({where:{companyId:A}});expect(entries).toHaveLength(4);expect(entries.every(e=>e.fuente==="MANUAL")).toBe(true);
    expect(entries.reduce((n,e)=>n+(e.tipo==="CARGO"?1:-1)*Number(e.monto),0)).toBe(0);
    expect(await prisma.bankTransaction.count({where:{companyId:A}})).toBe(1);
    expect(await prisma.bankStatementRow.count({where:{batch:{companyId:A}}})).toBe(2);
    expect(await prisma.bankReviewDecision.count({where:{companyId:A}})).toBe(1);
  });
  it("blocks closed periods and dependent fiscal links", async () => {
    await ingest("double.csv",[row(-100),row(-100)]);const r=await accountReview(scope);const [a,b]=r.movements;
    const op:ReviewOperation={type:"pair",primaryId:a.id,secondaryId:b.id,resolution:"MERGE",reason:"Duplicate candidate needs review"};
    const invoice=await prisma.invoice.create({data:{companyId:A,uuid:"itest-statement-invoice",tipo:"EGRESO",fecha:b.fecha,contraparteRfc:"AAA010101AAA",contraparteNombre:"Test",subtotal:100,total:100,formaPago:"03",metodoPago:"PUE",usoCfdi:"G03",moneda:"MXN"}});
    await prisma.bankTransaction.update({where:{id:b.id},data:{invoiceId:invoice.id}});
    await expect(prepared(op)).rejects.toThrow(/aplicaciones/);
    await prisma.bankTransaction.update({where:{id:b.id},data:{invoiceId:null}});
    await prisma.accountingPeriod.create({data:{companyId:A,year:2025,month:13,status:"POSTED",entriesCount:2}});
    await cerrarEjercicio(A,2025);
    await expect(prepared(op)).rejects.toThrow(/cerrado/);
  });
  it("defers category posting until verified, then posts exactly once", async () => {
    const doc=await ingest("fees.csv",[row(-100,"fee")]);const [movement]=(await accountReview(scope)).movements;
    const draft=await aprobarSugerencia(movement.id,"COMISION");expect(draft).toMatchObject({ok:true,deferred:true,entries:0});
    await verify(doc.batchId,[-100]);
    expect(await aprobarSugerencia(movement.id,"COMISION")).toMatchObject({ok:true,created:true,entries:2});
    expect(await aprobarSugerencia(movement.id,"COMISION")).toMatchObject({ok:true,created:false,entries:2});
    expect(await prisma.accountingEntry.count({where:{companyId:A}})).toBe(2);
    await postMonth({companyId:A,year:2025,month:9});
    expect(await prisma.accountingEntry.count({where:{companyId:A,fuente:"BANCO"}})).toBe(2);
  });
  it("enforces tenant, viewer and confirmation boundaries in the API and chat tool", async () => {
    await ingest("both.csv",[row(-100),row(-100)]);const r=await accountReview(scope),[a,b]=r.movements;
    const input={bank_account_id:scope.bankAccountId,year:2025,month:9,expected:r.hash,resolution:"KEEP_BOTH",primary_id:a.id,secondary_id:b.id,reason:"Two documented payments retained"};
    expect(JSON.parse(await executeBankStatementTool("query_statement_review",input,B,{userId:U}))).toHaveProperty("error");
    expect(JSON.parse(await executeBankStatementTool("proponer_revision_bancaria",input,A,{inApp:true,userId:V,conversationId:A+"-chat"}))).toHaveProperty("error");
    const staged=JSON.parse(await executeBankStatementTool("proponer_revision_bancaria",input,A,{inApp:true,userId:U,conversationId:A+"-chat"}));expect(staged.pending).toBe(true);
    expect(await prisma.bankReviewDecision.count({where:{companyId:A}})).toBe(0);
    const pending=(await getChatPendingAction(A+"-chat"))!;
    actor=V;expect((await POST(new Request("http://localhost/api/bancos/statement-review",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"confirm",request:pending.payload})}))).status).toBe(403);
    const result = await executeChatPendingAction(pending,U); expect(result, JSON.stringify(result)).toMatchObject({ok:true});
    expect((await accountReview(scope)).duplicates).toHaveLength(0);
  });
  it("requires a full statement for a known bank account even with no movements", async () => {
    expect((await statementPostingGate(A,2025,9)).ok).toBe(false);
    const doc=await ingest("empty-statement.pdf",[]);await verify(doc.batchId,[]);
    expect((await statementPostingGate(A,2025,9)).ok).toBe(true);
  });
  it("blocks legacy deletion after a later document corroborates a historic movement", async () => {
    const legacy = await prisma.importBatch.create({ data: { companyId: A, bankAccountId: scope.bankAccountId, source: "UPLOAD", count: 1 } });
    const movement = await prisma.bankTransaction.create({ data: { companyId: A, bankAccountId: scope.bankAccountId, fecha: row(100).fecha, monto: 100,
      descripcion: "Historic movement", tipo: "CREDITO", source: "UPLOAD", importBatchId: legacy.id, bankReferenceId: "historic-id" } });
    await ingest("new-evidence.ofx", [row(100, "historic-id")]);
    await expect(deshacerLoteImportado(legacy.id, A, U)).rejects.toThrow(/Otro documento/);
    const response = await DELETE(new Request("http://localhost/api/bancos/transactions/" + movement.id, { method: "DELETE" }), { params: Promise.resolve({ txId: movement.id }) });
    expect(response.status).toBe(409);
    expect(await prisma.bankTransaction.count({ where: { id: movement.id } })).toBe(1);
    expect(await prisma.bankStatementRow.count({ where: { movementId: movement.id } })).toBe(1);
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: legacy.id } })).undoneAt).toBeNull();
  });
  it("blocks legacy deletion in closed periods even without source rows", async () => {
    const movement = await prisma.bankTransaction.create({ data: { companyId: A, bankAccountId: scope.bankAccountId, fecha: row(100).fecha, monto: 100, descripcion: "Closed historic movement", tipo: "CREDITO", source: "UPLOAD" } });
    await prisma.accountingPeriod.create({ data: { companyId: A, year: 2025, month: 9, status: "CLOSED" } });
    const response = await DELETE(new Request("http://localhost/api/bancos/transactions/" + movement.id, { method: "DELETE" }), { params: Promise.resolve({ txId: movement.id }) });
    expect(response.status).toBe(409);
    expect(await prisma.bankTransaction.count({ where: { id: movement.id } })).toBe(1);
  });
  it("retains originals during account selection and prevents cross-company retrieval", async () => {
    const id=await stageBankOriginal(A,Buffer.from("synthetic source"),"original.pdf","application/pdf",{saldoInicial:100,holdForReview:true});
    expect(Buffer.from((await readBankOriginal(A,id)).archivo.bytes).toString()).toBe("synthetic source");
    await expect(readBankOriginal(B,id)).rejects.toThrow(/pertenece/);
  });
  it("keeps closed-month uploads as review evidence without adding canonical movements", async () => {
    await prisma.accountingPeriod.create({data:{companyId:A,year:2025,month:9,status:"CLOSED"}});
    const doc=await ingest("late-closed.csv",[row(-100,"new")]);expect(doc).toMatchObject({imported:0,pending:1});
    expect(await prisma.bankStatementRow.count({where:{batchId:doc.batchId}})).toBe(1);
  });
  it("uses a bounded CEP lookup, caches its original and never calls a provider for missing evidence", async () => {
    await ingest("spei.csv",[row(-100,"cep")]);const [m]=(await accountReview(scope)).movements;
    const fetchImpl=vi.fn().mockResolvedValue({ok:true,status:200,json:async()=>({found:true,estado:"Liquidado",xml_content:'<SPEI_Tercero FechaOperacion="2025-09-15"><Ordenante Cuenta="012000000000000001" RFC="AAA010101AAA" Nombre="Synthetic payer"/><Beneficiario Cuenta="002000000000000002" RFC="BBB010101BBB" Nombre="Synthetic payee" MontoPago="100.00"/></SPEI_Tercero>'})});
    expect((await lookupMovementCep(A,m.id,{apiKey:"synthetic-test-key",fetchImpl:fetchImpl as never})).status).toBe("MISSING_EVIDENCE");expect(fetchImpl).not.toHaveBeenCalled();
    await prisma.bankAccount.update({where:{id:scope.bankAccountId},data:{clabe:"012000000000000001"}});
    await prisma.bankTransaction.update({where:{id:m.id},data:{claveRastreo:"SYNTHETIC-CEP",contraparteClabe:"002000000000000002"}});
    expect((await lookupMovementCep(A,m.id,{apiKey:"synthetic-test-key",fetchImpl:fetchImpl as never})).status).toBe("SAVED");
    expect((await lookupMovementCep(A,m.id,{apiKey:"synthetic-test-key",fetchImpl:fetchImpl as never})).status).toBe("SAVED");expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(lookupMovementCep(B,m.id,{apiKey:"synthetic-test-key",fetchImpl:fetchImpl as never})).rejects.toThrow(/empresa/);
    expect(await prisma.accountingEntry.count({where:{companyId:A}})).toBe(0);
  });

});
