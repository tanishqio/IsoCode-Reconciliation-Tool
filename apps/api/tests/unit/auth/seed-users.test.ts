import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { readSeedUsers, seedUsers } from "../../../src/db/seed-users.js";

const validEnv = {
  SEED_EXECUTIVE_EMAIL: "exec@example.test",
  SEED_EXECUTIVE_PASSWORD: "executive-password-1",
  SEED_COFOUNDER_EMAIL: "founder@example.test",
  SEED_COFOUNDER_PASSWORD: "cofounder-password-1",
};

describe("readSeedUsers", () => {
  it("reads one finance executive and one co-founder, with default names", () => {
    const users = readSeedUsers(validEnv);
    expect(users).toHaveLength(2);
    expect(users[0]).toMatchObject({
      email: "exec@example.test",
      role: "FINANCE_EXECUTIVE",
      name: "Demo Executive",
    });
    expect(users[1]).toMatchObject({
      email: "founder@example.test",
      role: "CO_FOUNDER",
      name: "Demo Co-founder",
    });
  });

  it("uses names from the environment when given", () => {
    const users = readSeedUsers({
      ...validEnv,
      SEED_EXECUTIVE_NAME: "Priya",
      SEED_COFOUNDER_NAME: "Rahul",
    });
    expect(users.map((user) => user.name)).toEqual(["Priya", "Rahul"]);
  });

  it("lists the missing variables by name only, never their values", () => {
    const attempt = () =>
      readSeedUsers({
        SEED_EXECUTIVE_EMAIL: "exec@example.test",
        SEED_EXECUTIVE_PASSWORD: "super-secret-value-1",
      });
    expect(attempt).toThrow(/SEED_COFOUNDER_EMAIL/);
    expect(attempt).toThrow(/SEED_COFOUNDER_PASSWORD/);
    expect(attempt).not.toThrow(/super-secret-value-1/);
  });

  it("refuses two accounts with the same email, ignoring letter case", () => {
    expect(() => readSeedUsers({ ...validEnv, SEED_COFOUNDER_EMAIL: "EXEC@example.test" })).toThrow(
      /different emails/,
    );
  });
});

describe("seedUsers", () => {
  const fakePrisma = () => {
    const upsert = vi.fn<(args: unknown) => Promise<object>>(async () => ({}));
    return { client: { user: { upsert } } as unknown as PrismaClient, upsert };
  };

  it("rejects a password shorter than 12 characters, without writing anything", async () => {
    const { client, upsert } = fakePrisma();
    await expect(
      seedUsers(
        client,
        [{ email: "a@example.test", name: "A", role: "CO_FOUNDER", password: "short" }],
        4,
      ),
    ).rejects.toThrow(/12 to 72/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects a password longer than bcrypt can use", async () => {
    const { client } = fakePrisma();
    await expect(
      seedUsers(
        client,
        [{ email: "a@example.test", name: "A", role: "CO_FOUNDER", password: "x".repeat(73) }],
        4,
      ),
    ).rejects.toThrow(/12 to 72/);
  });

  it("stores a bcrypt hash, never the password, and lower-cases the email", async () => {
    const { client, upsert } = fakePrisma();
    await seedUsers(
      client,
      [
        {
          email: " Exec@Example.Test ",
          name: "Exec",
          role: "FINANCE_EXECUTIVE",
          password: "executive-password-1",
        },
      ],
      4,
    );
    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0]![0] as unknown as {
      where: { email: string };
      create: { passwordHash: string; role: string };
      update: Record<string, unknown>;
    };
    expect(arg.where.email).toBe("exec@example.test");
    expect(arg.create.passwordHash).toMatch(/^\$2[aby]\$04\$/);
    expect(JSON.stringify(arg)).not.toContain("executive-password-1");
    expect(arg.create.role).toBe("FINANCE_EXECUTIVE");
  });

  it("when the user exists, resets the password, re-enables the account and clears any lock", async () => {
    const { client, upsert } = fakePrisma();
    await seedUsers(
      client,
      [
        {
          email: "a@example.test",
          name: "A",
          role: "CO_FOUNDER",
          password: "cofounder-password-1",
        },
      ],
      4,
    );
    const arg = upsert.mock.calls[0]![0] as unknown as { update: Record<string, unknown> };
    expect(arg.update).toMatchObject({ isActive: true, failedLoginCount: 0, lockedUntil: null });
    expect(String(arg.update["passwordHash"])).toMatch(/^\$2[aby]\$04\$/);
  });
});
