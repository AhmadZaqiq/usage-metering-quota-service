import { describe, it, expect } from "vitest";
import { evaluateQuota } from "../modules/usage/quotaEvaluator.js";
import { MAX_UNITS_PER_REQUEST_BIGINT } from "../config/index.js";

describe("Quota Evaluator (Pure Function Unit Tests)", () => {
  const accountPlan = {
    monthlyAllowance: 1000n,
    maxUnitsPerRequest: 100n,
  };

  const userPlan = {
    monthlyAllowance: 100n,
    maxUnitsPerRequest: 10n,
  };

  describe("Account quota boundary", () => {
    it("should accept request that exactly consumes remaining account quota", () => {
      const result = evaluateQuota({
        accountPlan,
        userPlan: null,
        accountUsed: 995n,
        userUsed: 0n,
        requestedUnits: 5n,
        maxUnitsPerRequestLimit: MAX_UNITS_PER_REQUEST_BIGINT,
      });

      expect(result.decision).toBe("accepted");
      expect(result.accountRemaining).toBe(0n);
    });

    it("should reject request exceeding remaining account quota by one unit", () => {
      const result = evaluateQuota({
        accountPlan,
        userPlan: null,
        accountUsed: 995n,
        userUsed: 0n,
        requestedUnits: 6n,
        maxUnitsPerRequestLimit: MAX_UNITS_PER_REQUEST_BIGINT,
      });

      expect(result.decision).toBe("rejected");
      expect(result.rejectionReason).toBe("account_quota_exceeded");
      expect(result.accountRemaining).toBe(5n);
    });

    it("should handle zero remaining quota correctly", () => {
      const result = evaluateQuota({
        accountPlan,
        userPlan: null,
        accountUsed: 1000n,
        userUsed: 0n,
        requestedUnits: 1n,
        maxUnitsPerRequestLimit: MAX_UNITS_PER_REQUEST_BIGINT,
      });

      expect(result.decision).toBe("rejected");
      expect(result.rejectionReason).toBe("account_quota_exceeded");
      expect(result.accountRemaining).toBe(0n);
    });

    it("should reject negative remaining quota", () => {
      // Edge case: admin manually set counter > allowance
      const result = evaluateQuota({
        accountPlan,
        userPlan: null,
        accountUsed: 1005n,
        userUsed: 0n,
        requestedUnits: 1n,
        maxUnitsPerRequestLimit: MAX_UNITS_PER_REQUEST_BIGINT,
      });

      expect(result.decision).toBe("rejected");
      expect(result.rejectionReason).toBe("account_quota_exceeded");
      expect(result.accountRemaining).toBe(-5n);
    });
  });

  describe("User quota boundary", () => {
    it("should accept request that exactly consumes remaining user quota", () => {
      const result = evaluateQuota({
        accountPlan,
        userPlan,
        accountUsed: 500n,
        userUsed: 95n,
        requestedUnits: 5n,
        maxUnitsPerRequestLimit: MAX_UNITS_PER_REQUEST_BIGINT,
      });

      expect(result.decision).toBe("accepted");
      expect(result.userRemaining).toBe(0n);
    });

    it("should reject request exceeding remaining user quota by one unit", () => {
      const result = evaluateQuota({
        accountPlan,
        userPlan,
        accountUsed: 500n,
        userUsed: 95n,
        requestedUnits: 6n,
        maxUnitsPerRequestLimit: MAX_UNITS_PER_REQUEST_BIGINT,
      });

      expect(result.decision).toBe("rejected");
      expect(result.rejectionReason).toBe("user_quota_exceeded");
      expect(result.userRemaining).toBe(5n);
    });

    it("should enforce both account and user quota simultaneously (account checked first)", () => {
      // Account has 2 remaining, user has 2 remaining, request 3
      // Account quota is checked first, so it fails on account quota
      const result = evaluateQuota({
        accountPlan,
        userPlan,
        accountUsed: 998n,
        userUsed: 98n,
        requestedUnits: 3n,
        maxUnitsPerRequestLimit: MAX_UNITS_PER_REQUEST_BIGINT,
      });

      expect(result.decision).toBe("rejected");
      expect(result.rejectionReason).toBe("account_quota_exceeded");
    });
  });

  describe("Per-request maximum", () => {
    it("should accept request at exactly max per request", () => {
      const result = evaluateQuota({
        accountPlan,
        userPlan: null,
        accountUsed: 0n,
        userUsed: 0n,
        requestedUnits: 100n, // Exactly at limit
        maxUnitsPerRequestLimit: MAX_UNITS_PER_REQUEST_BIGINT,
      });

      expect(result.decision).toBe("accepted");
    });

    it("should reject request exceeding max per request by one unit", () => {
      const result = evaluateQuota({
        accountPlan,
        userPlan: null,
        accountUsed: 0n,
        userUsed: 0n,
        requestedUnits: 101n, // 1 over limit
        maxUnitsPerRequestLimit: MAX_UNITS_PER_REQUEST_BIGINT,
      });

      expect(result.decision).toBe("rejected");
      expect(result.rejectionReason).toBe("max_per_request_exceeded");
    });

    it("should reject zero units", () => {
      const result = evaluateQuota({
        accountPlan,
        userPlan: null,
        accountUsed: 0n,
        userUsed: 0n,
        requestedUnits: 0n,
        maxUnitsPerRequestLimit: MAX_UNITS_PER_REQUEST_BIGINT,
      });

      expect(result.decision).toBe("rejected");
      expect(result.rejectionReason).toBe("max_per_request_exceeded");
    });

    it("should reject negative units", () => {
      const result = evaluateQuota({
        accountPlan,
        userPlan: null,
        accountUsed: 0n,
        userUsed: 0n,
        requestedUnits: -1n,
        maxUnitsPerRequestLimit: MAX_UNITS_PER_REQUEST_BIGINT,
      });

      expect(result.decision).toBe("rejected");
      expect(result.rejectionReason).toBe("max_per_request_exceeded");
    });

    it("should reject units exceeding global MAX_UNITS_PER_REQUEST", () => {
      const result = evaluateQuota({
        accountPlan,
        userPlan: null,
        accountUsed: 0n,
        userUsed: 0n,
        requestedUnits: MAX_UNITS_PER_REQUEST_BIGINT + 1n,
        maxUnitsPerRequestLimit: MAX_UNITS_PER_REQUEST_BIGINT,
      });

      expect(result.decision).toBe("rejected");
      expect(result.rejectionReason).toBe("max_per_request_exceeded");
    });

    it("should respect the lower of account and user max per request", () => {
      const result = evaluateQuota({
        accountPlan: { monthlyAllowance: 1000n, maxUnitsPerRequest: 50n },
        userPlan: { monthlyAllowance: 100n, maxUnitsPerRequest: 10n },
        accountUsed: 0n,
        userUsed: 0n,
        requestedUnits: 15n, // Over user limit (10) but under account limit (50)
        maxUnitsPerRequestLimit: MAX_UNITS_PER_REQUEST_BIGINT,
      });

      expect(result.decision).toBe("rejected");
      expect(result.rejectionReason).toBe("max_per_request_exceeded");
    });
  });

  describe("Bigint arithmetic correctness", () => {
    it("should handle values at database limit within MAX_UNITS_PER_REQUEST", () => {
      const result = evaluateQuota({
        accountPlan: {
          monthlyAllowance: 9223372036854775807n, // MAX BIGINT
          maxUnitsPerRequest: MAX_UNITS_PER_REQUEST_BIGINT,
        },
        userPlan: null,
        accountUsed: 0n,
        userUsed: 0n,
        requestedUnits: MAX_UNITS_PER_REQUEST_BIGINT, // Max allowed
        maxUnitsPerRequestLimit: MAX_UNITS_PER_REQUEST_BIGINT,
      });

      expect(result.decision).toBe("accepted");
      expect(result.accountRemaining).toBe(9223372036854775807n - MAX_UNITS_PER_REQUEST_BIGINT);
    });

    it("should handle large values correctly without floating point errors", () => {
      const result = evaluateQuota({
        accountPlan: { monthlyAllowance: 10000000000000000n, maxUnitsPerRequest: 1000000000000000n },
        userPlan: { monthlyAllowance: 1000000000000000n, maxUnitsPerRequest: 100000000000000n },
        accountUsed: 9999999999999999n,
        userUsed: 99999999999999n,
        requestedUnits: 1n,
        maxUnitsPerRequestLimit: MAX_UNITS_PER_REQUEST_BIGINT,
      });

      expect(result.decision).toBe("accepted");
      expect(result.accountRemaining).toBe(0n);
      expect(result.userRemaining).toBe(1000000000000000n - 99999999999999n - 1n);
    });
  });
});