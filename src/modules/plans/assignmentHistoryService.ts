import { db } from "../../db/client.js";
import { listAssignmentsWithPlan, getCurrentAssignmentsWithPlan } from "./assignmentRepository.js";
import type { AssignmentInfo } from "./assignmentService.js";
import { formatDateForDb } from "../../utils/date.js";

export async function listAssignments(accountId: number): Promise<AssignmentInfo[]> {
  const results = await listAssignmentsWithPlan(db, BigInt(accountId));
  return results.map(mapAssignmentWithPlan);
}

export async function getCurrentAssignments(accountId: number): Promise<{
  account: AssignmentInfo | null;
  users: AssignmentInfo[];
}> {
  const results = await getCurrentAssignmentsWithPlan(db, BigInt(accountId));

  const account = results.find((r) => r.userId === null) ?? null;
  const users = results.filter((r) => r.userId !== null);

  return {
    account: account ? mapAssignmentWithPlan(account) : null,
    users: users.map(mapAssignmentWithPlan),
  };
}

function mapAssignmentWithPlan(r: { id: bigint; accountId: bigint; userId: bigint | null; planId: bigint; effectiveFrom: Date; effectiveTo: Date | null; createdAt: Date; planName: string; planType: string }): AssignmentInfo {
  return {
    id: Number(r.id),
    accountId: Number(r.accountId),
    userId: r.userId ? Number(r.userId) : null,
    planId: Number(r.planId),
    planName: r.planName,
    planType: r.planType as "account" | "user",
    effectiveFrom: formatDateForDb(r.effectiveFrom),
    effectiveTo: r.effectiveTo ? formatDateForDb(r.effectiveTo) : null,
    createdAt: r.createdAt,
    isCurrent: r.effectiveTo === null,
  };
}
