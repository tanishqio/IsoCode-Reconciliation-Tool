import { pathToFileURL } from "node:url";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { createRateCardsService } from "../modules/rate-cards/rate-cards.service.js";
import { rulesSchema, type RuleInput } from "../modules/rate-cards/rate-cards.schemas.js";

// DEMO VALUES ONLY. The assignment gives no rate card values, so these are sample numbers, marked
// "sample" on screen (isSampleData). They are chosen so the three sample rows of the assignment
// work out exactly:
//   ORD-W-204118  Website, COD, 1499          -> 1499 - 60 (delivery) - 30 (COD fee)          = 1409
//   ORD-M-88120   Marketplace 1, prepaid 1199 -> 1199 - 239.80 (20%) - 25 - 35.20 (delivery)  = 899
//   ORD-W-204377  Website, returned           -> -96 (return delivery charge)
// Replace them with the real rates when the finance team provides them.

export interface RateCardSeed {
  channel: string;
  courier: string | null;
  rules: RuleInput[];
}

const SAMPLE_NOTE = "Sample values for the demo, not real partner rates.";

const slab = (min: number, max: number | null, amount: string): RuleInput => ({
  ruleType: "FREIGHT_SLAB",
  minWeightGrams: min,
  maxWeightGrams: max,
  amount,
});
const fee = (ruleType: RuleInput["ruleType"], amount: string): RuleInput => ({ ruleType, amount });
const commission = (basisPoints: number): RuleInput => ({ ruleType: "COMMISSION", basisPoints });

export const RATE_CARD_SEED: RateCardSeed[] = [
  {
    channel: "Website",
    courier: "Aggregator 1",
    rules: [
      slab(0, 500, "60.00"),
      slab(501, 1000, "90.00"),
      slab(1001, 2000, "130.00"),
      slab(2001, null, "180.00"),
      fee("COD_FEE", "30.00"),
      fee("REVERSE_FREIGHT", "96.00"),
    ],
  },
  {
    channel: "Website",
    courier: "Aggregator 2",
    rules: [
      slab(0, 500, "65.00"),
      slab(501, 1000, "95.00"),
      slab(1001, 2000, "135.00"),
      slab(2001, null, "185.00"),
      fee("COD_FEE", "35.00"),
      fee("REVERSE_FREIGHT", "100.00"),
    ],
  },
  {
    channel: "Marketplace 1",
    courier: null,
    rules: [
      commission(2000),
      fee("FIXED_FEE", "25.00"),
      slab(0, null, "35.20"),
      fee("REVERSE_FREIGHT", "80.00"),
    ],
  },
  {
    channel: "Marketplace 2",
    courier: null,
    rules: [
      commission(1800),
      fee("FIXED_FEE", "20.00"),
      slab(0, null, "40.00"),
      fee("REVERSE_FREIGHT", "85.00"),
    ],
  },
  {
    channel: "Marketplace 3",
    courier: null,
    rules: [
      commission(2200),
      fee("FIXED_FEE", "30.00"),
      slab(0, null, "38.00"),
      fee("REVERSE_FREIGHT", "90.00"),
    ],
  },
  {
    channel: "Quick Commerce 1",
    courier: null,
    rules: [commission(2500), fee("FIXED_FEE", "15.00"), fee("REVERSE_FREIGHT", "70.00")],
  },
  {
    channel: "Quick Commerce 2",
    courier: null,
    rules: [commission(2400), fee("FIXED_FEE", "12.00"), fee("REVERSE_FREIGHT", "65.00")],
  },
];

/**
 * Creates the sample cards that do not exist yet. Safe to run again: a channel and courier pair
 * that already has a card (sample or real, any version) is left alone, so nothing is overwritten.
 * Needs the sources and the finance executive account (run `npm run db:seed` first).
 */
export async function seedRateCards(
  prisma: PrismaClient,
  seed: RateCardSeed[] = RATE_CARD_SEED,
): Promise<{ created: number; skipped: number }> {
  const owner = await prisma.user.findFirst({
    where: { role: "FINANCE_EXECUTIVE", isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!owner) {
    throw new Error("No finance executive account found. Run `npm run db:seed:users` first.");
  }

  const service = createRateCardsService({ prisma });
  let created = 0;
  let skipped = 0;

  for (const entry of seed) {
    const channel = await prisma.source.findUnique({ where: { name: entry.channel } });
    const courier = entry.courier
      ? await prisma.source.findUnique({ where: { name: entry.courier } })
      : null;
    if (!channel || (entry.courier && !courier)) {
      throw new Error(
        `Source "${entry.channel}"${entry.courier ? ` or "${entry.courier}"` : ""} was not found. Run \`npm run db:seed:sources\` first.`,
      );
    }
    const existing = await prisma.rateCard.findFirst({
      where: { channelSourceId: channel.id, courierSourceId: courier?.id ?? null },
      select: { id: true },
    });
    if (existing) {
      skipped += 1;
      continue;
    }
    await service.create(
      {
        channelSourceId: channel.id,
        courierSourceId: courier?.id ?? null,
        note: SAMPLE_NOTE,
        isSampleData: true,
        rules: rulesSchema.parse(entry.rules),
      },
      owner.id,
    );
    created += 1;
  }
  return { created, skipped };
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const { prisma } = await import("./prisma.js");
  try {
    const { created, skipped } = await seedRateCards(prisma);
    console.log(`Sample rate cards: ${created} created, ${skipped} already existed.`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : "Seeding rate cards failed.");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
