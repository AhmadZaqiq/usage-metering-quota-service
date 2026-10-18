import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { accounts } from "../db/schema/index.js";
import { getTestDb, getTestPool } from "./setup.js";
import { selectAccountByName } from "../infrastructure/repositories/accountRepository.js";

describe("accountRepository mapping", () => {
  it("selectAccountByName returns fully mapped camelCase fields", async () => {
    const db = getTestDb();
    const name = `acct-map-${Date.now()}`;
    const [inserted] = await db
      .insert(accounts)
      .values({ name })
      .returning()
      .execute();

    const found = await selectAccountByName(db, name);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(inserted.id);
    expect(found!.name).toBe(name);
    // Regression guard: the previous raw-SQL select returned snake_case keys
    // while the mapper read camelCase, silently yielding undefined here.
    expect(found!.isActive).toBe(true);
    expect(found!.createdAt).toBeInstanceOf(Date);
    expect(found!.updatedAt).toBeInstanceOf(Date);
    expect(found!.deletedAt).toBeNull();
  });

  it("selectAccountByName skips soft-deleted accounts", async () => {
    const db = getTestDb();
    const pool = getTestPool();
    const name = `acct-deleted-${Date.now()}`;
    const [inserted] = await db
      .insert(accounts)
      .values({ name })
      .returning({ id: accounts.id })
      .execute();

    await pool.query("UPDATE accounts SET deleted_at = NOW() WHERE id = $1", [
      inserted.id,
    ]);

    const found = await selectAccountByName(db, name);
    expect(found).toBeNull();
  });
});
