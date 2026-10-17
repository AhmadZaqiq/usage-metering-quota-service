import { db, withTransaction } from "../../db/client.js";
import {
  selectUserByAccountAndClientUserId,
  insertUser,
  selectUsersByAccount,
} from "./userRepository.js";
import { ValidationError } from "../../errors/AppError.js";

export interface UserInfo {
  id: number;
  clientUserId: string;
  isActive?: boolean;
  createdAt: Date;
}

export async function createUser(accountId: number, clientUserId: string): Promise<UserInfo> {
  return await withTransaction(async (tx) => {
    const existing = await selectUserByAccountAndClientUserId(tx, BigInt(accountId), clientUserId);

    if (existing) {
      throw new ValidationError("User with this identifier already exists");
    }

    try {
      const user = await insertUser(tx, BigInt(accountId), clientUserId);

      return {
        id: Number(user.id),
        clientUserId: user.clientUserId,
        createdAt: user.createdAt,
      };
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      if (pgCode === "23505") {
        // uq_users_account_client_user unique constraint violated
        throw new ValidationError("User with this identifier already exists");
      }
      throw err;
    }
  });
}

export async function listUsers(accountId: number): Promise<UserInfo[]> {
  const userList = await selectUsersByAccount(db, BigInt(accountId));

  return userList.map((u) => ({
    id: Number(u.id),
    clientUserId: u.clientUserId,
    isActive: u.isActive,
    createdAt: u.createdAt,
  }));
}
