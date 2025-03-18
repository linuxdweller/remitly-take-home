import { PrismaClient } from "@prisma/client";
import { sign, SignOptions } from "jsonwebtoken";
import { readFileSync } from "fs";
import bcrypt from "bcryptjs";

export async function createUser(
  client: PrismaClient,
  { email, password }: { email: string; password: string },
) {
  const passwordHash = bcrypt.hashSync(password);

  const user = await client.users.create({
    data: {
      email,
      password: passwordHash,
      balance: 1000,
    },
  });

  return {
    id: user.id,
  };
}

export async function createToken({
  userId,
  expiresIn,
}: { userId: number; expiresIn?: SignOptions["expiresIn"] }) {
  const privateKey = readFileSync("./secret/id_ed25519");

  // Expires immidietly,
  const token = sign({ userId }, privateKey, {
    algorithm: "HS512",
    expiresIn: expiresIn ?? "1h",
  });

  return { token };
}
