import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Role } from "../../generated/prisma/enums.js";
import { hashPassword, isPasswordLengthOk } from "../lib/passwords.js";

export interface UserSeed {
  email: string;
  name: string;
  role: Role;
  password: string;
}

const MIN_PASSWORD_LENGTH = 12;

/**
 * Creates the user, or updates it if the email already exists. Running it again with a new
 * password changes the password, and also clears any sign-in lock, so it doubles as "unlock".
 */
export async function seedUsers(
  prisma: PrismaClient,
  users: UserSeed[],
  bcryptCost: number,
): Promise<void> {
  for (const user of users) {
    if (user.password.length < MIN_PASSWORD_LENGTH || !isPasswordLengthOk(user.password)) {
      throw new Error(
        `The password for ${user.email} must be ${MIN_PASSWORD_LENGTH} to 72 characters.`,
      );
    }
    const passwordHash = await hashPassword(user.password, bcryptCost);
    const email = user.email.trim().toLowerCase();
    await prisma.user.upsert({
      where: { email },
      create: { email, name: user.name, role: user.role, passwordHash },
      update: {
        name: user.name,
        role: user.role,
        passwordHash,
        isActive: true,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
  }
}

// The two accounts come from environment variables (apps/api/.env, which git ignores).
// No password is written in the code or in any tracked file.
const seedEnvSchema = z.object({
  SEED_EXECUTIVE_EMAIL: z.string().min(3),
  SEED_EXECUTIVE_PASSWORD: z.string(),
  SEED_EXECUTIVE_NAME: z.string().min(1).default("Demo Executive"),
  SEED_COFOUNDER_EMAIL: z.string().min(3),
  SEED_COFOUNDER_PASSWORD: z.string(),
  SEED_COFOUNDER_NAME: z.string().min(1).default("Demo Co-founder"),
});

export function readSeedUsers(source: NodeJS.ProcessEnv): UserSeed[] {
  const parsed = seedEnvSchema.safeParse(source);
  if (!parsed.success) {
    // Names of the missing variables only, never their values.
    const names = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Set these in apps/api/.env before seeding users: ${names}`);
  }
  const value = parsed.data;
  if (
    value.SEED_EXECUTIVE_EMAIL.trim().toLowerCase() ===
    value.SEED_COFOUNDER_EMAIL.trim().toLowerCase()
  ) {
    throw new Error("The two accounts need different emails.");
  }
  return [
    {
      email: value.SEED_EXECUTIVE_EMAIL,
      name: value.SEED_EXECUTIVE_NAME,
      role: "FINANCE_EXECUTIVE",
      password: value.SEED_EXECUTIVE_PASSWORD,
    },
    {
      email: value.SEED_COFOUNDER_EMAIL,
      name: value.SEED_COFOUNDER_NAME,
      role: "CO_FOUNDER",
      password: value.SEED_COFOUNDER_PASSWORD,
    },
  ];
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const { env } = await import("../config/env.js");
  const { prisma } = await import("./prisma.js");
  try {
    const users = readSeedUsers(process.env);
    await seedUsers(prisma, users, env.BCRYPT_COST);
    console.log(
      `Seeded ${users.length} users: ${users.map((user) => `${user.email} (${user.role})`).join(", ")}.`,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : "Seeding users failed.");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
