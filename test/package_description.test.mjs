/**
 * test/package_description.test.mjs
 *
 * npm stores at most 255 characters of a package description. Through 0.2.x
 * the description was 435 characters, and the npm page ended mid-word, after
 * "coverage reconciliation a". A receipt is written only when a receipt sink
 * is configured, so a description that names receipts keeps that condition.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("package description", () => {
  it("fits in the 255 characters npm keeps", () => {
    expect(pkg.description.length).toBeLessThanOrEqual(255);
  });

  it("states the receipt-sink condition when it names receipts", () => {
    if (/receipt/i.test(pkg.description)) {
      expect(pkg.description).toMatch(/receipt sink is configured/);
    }
  });
});
