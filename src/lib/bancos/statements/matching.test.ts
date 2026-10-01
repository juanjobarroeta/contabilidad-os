import { describe, expect, it } from "vitest";
import { digest, checkControls, duplicateCases, planRows, type MovementEvidence } from "./matching";
const tx = (id: string, extra: Partial<MovementEvidence> = {}): MovementEvidence => ({ id, date: "2026-09-15", amount: -35000, description: "SPEI", ...extra });
describe("statement identity and multiplicity", () => {
  it("links CSV/PDF descriptions by a compatible bank identity", () => expect(planRows([tx("pdf", { tracking: "ABC", description: "TRANSFER TO MERCEDES" })], [tx("csv", { tracking: "ABC" })])[0]).toMatchObject({ status: "LINKED", movementId: "csv" }));
  it("preserves equal payments minutes apart and with distinct references", () => {
    expect(planRows([tx("new", { time: "12:02:00" })], [tx("old", { time: "12:01:00" })])[0].status).toBe("NEW");
    expect(duplicateCases([tx("a", { tracking: "ABC" }), tx("b", { tracking: "DEF" })])).toHaveLength(0);
  });
  it("preserves two identical rows in a fresh file", () => expect(planRows([tx("a"), tx("b")], []).map((p) => p.status)).toEqual(["NEW", "NEW"]));
  it("does not silently skip an ambiguous partial upload", () => expect(planRows([tx("new")], [tx("old")])[0].status).toBe("REVIEW"));
  it("uses a movement only once per document", () => expect(planRows([tx("a", { tracking: "ABC" }), tx("b", { tracking: "ABC" })], [tx("old", { tracking: "ABC" })]).map((p) => p.status)).toEqual(["LINKED", "REVIEW"]));
  it("holds changed amount or date despite identical identity", () => {
    expect(planRows([tx("a", { tracking: "ABC", amount: -36000 })], [tx("old", { tracking: "ABC" })])[0].status).toBe("REVIEW");
    expect(planRows([tx("a", { tracking: "ABC", date: "2026-09-16" })], [tx("old", { tracking: "ABC" })])[0].status).toBe("REVIEW");
  });
  it("remembers a keep-both decision only while its evidence is unchanged", () => {
    const rows = [tx("a"), tx("b")]; const c = duplicateCases(rows)[0];
    expect(duplicateCases(rows, [{ pairKey: c.key, fingerprint: c.fingerprint }])).toHaveLength(0);
    expect(duplicateCases([tx("a", { description: "changed" }), tx("b")], [{ pairKey: c.key, fingerprint: c.fingerprint }])).toHaveLength(1);
  });
});
describe("statement coverage controls", () => {
  it("rejects missing equal debit and credit even when net balances agree", () => expect(checkControls([], 100, 100, { credits: 35, debits: 35 }).errors).toHaveLength(2));
  it("unknown balances or controls never pass", () => expect(checkControls([], null, null, null).errors).toHaveLength(2));
  it("can verify a documented zero-activity month", () => expect(checkControls([], 100, 100, { credits: 0, debits: 0, creditCount: 0, debitCount: 0 }).errors).toEqual([]));
});

describe("persistent review fingerprints", () => {
  it("survives PostgreSQL JSON object key order", () => expect(digest({operation:{type:"row",reason:"same evidence",resolution:"LINK"},expected:"abc"})).toBe(digest({expected:"abc",operation:{reason:"same evidence",resolution:"LINK",type:"row"}})));
  it("holds contradictory bank identities for review", () => expect(planRows([tx("new",{bankId:"FIT1",tracking:"different"})],[tx("old",{bankId:"FIT1",tracking:"original"})])[0].status).toBe("REVIEW"));
});
