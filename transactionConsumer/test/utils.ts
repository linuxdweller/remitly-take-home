import { createHash } from "crypto";
import { PrismaClient } from "@prisma/client";

export async function createUser(
  client: PrismaClient,
  { email, password }: { email: string; password: string },
) {
  const hash = createHash("sha512");
  hash.update(password);

  const user = await client.users.create({
    data: {
      email,
      password: hash.digest().toString("hex"),
      balance: 1000,
    },
  });

  return {
    id: user.id,
  };
}
