import { createHash } from "crypto";

export interface RequestFingerprint {
  accountId: number;
  userId: string | null;
  units: string; // bigint as string
}

export function computeRequestHash(fingerprint: RequestFingerprint): string {
  const canonical = JSON.stringify({
    accountId: fingerprint.accountId,
    userId: fingerprint.userId,
    units: fingerprint.units,
  });
  return createHash("sha256").update(canonical).digest("hex");
}