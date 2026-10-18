import { describe, it, expect } from "vitest";
import { getTestPool } from "./setup.js";
import { setupBasicTestContext, makeUsageRequest } from "./utils.js";
import { verify } from "../scripts/verify-invariants.js";

describe("verify-invariants self-test", () => {
  it("passes on a consistent database and detects a seeded INV-1 mismatch", async () => {
    const ctx = await setupBasicTestContext();
    const decision = await makeUsageRequest(ctx.account.id, ctx.apiKey.id, {
      units: 5n,
      idempotencyKey: "inv-self-1",
    });
    expect(decision.decision).toBe("accepted");

    // A freshly written, consistent state must verify clean.
    expect(await verify()).toEqual([]);

    // Seed a controlled mismatch: inflate the account counter by 1 unit so it
    // no longer equals the accepted sum. INV-1 must report exactly this row.
    await getTestPool().query(
      "UPDATE usage_counters SET counter = counter + 1 WHERE account_id = $1 AND user_id IS NULL",
      [ctx.account.id]
    );

    const violations = await verify();
    const inv1 = violations.filter((v) => v.check === "INV-1");
    expect(inv1).toHaveLength(1);
    expect(inv1[0].detail).toContain(String(ctx.account.id));
  });
});
