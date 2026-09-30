import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  closeCases, fixtureVersion, periodCases, professionalReview, regimeCases, sourceCheckedAt,
} from "./fixtures/v1";

const fixtures = [...periodCases, ...closeCases, ...regimeCases];
const matrix = readFileSync(new URL("../../../docs/fiscal/QA-001-REVIEW-MATRIX-v1.md", import.meta.url), "utf8");

describe("QA-001 v1: catalog integrity and review traceability", () => {
  it("retains every versioned family and unique stable ID", () => {
    expect([periodCases.length, closeCases.length, regimeCases.length]).toEqual([10, 14, 18]);
    const ids = fixtures.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(42);
    expect(ids.every((id) => /^(PER|CLOSE|REG)-\d{3}$/.test(id))).toBe(true);
    expect(fixtures.every((fixture) => fixture.description.trim().length > 0)).toBe(true);
  });

  it("keeps the review matrix complete without implying accountant approval", () => {
    expect(professionalReview).toBe("PENDING");
    expect(matrix).toContain(`Fixture version: \`${fixtureVersion}\``);
    expect(matrix).toContain(`Official calendar sources checked: \`${sourceCheckedAt}\``);
    const rows = [...matrix.matchAll(/^\| ((?:PER|CLOSE|REG)-\d{3}) \|/gm)].map((match) => match[1]);
    expect(rows.sort()).toEqual(fixtures.map((fixture) => fixture.id).sort());
    for (const fixture of fixtures) {
      expect(matrix).toContain(`| ${fixture.id} | ${fixture.description} | PENDING |`);
    }
  });
});
