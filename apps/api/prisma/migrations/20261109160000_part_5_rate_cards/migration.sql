-- CreateEnum
CREATE TYPE "RateRuleType" AS ENUM ('COMMISSION', 'FIXED_FEE', 'FREIGHT_SLAB', 'COD_FEE', 'REVERSE_FREIGHT');

-- CreateEnum
CREATE TYPE "RateCardStatus" AS ENUM ('ACTIVE', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "rate_cards" (
    "id" UUID NOT NULL,
    "channelSourceId" UUID NOT NULL,
    "courierSourceId" UUID,
    "versionNo" INTEGER NOT NULL,
    "status" "RateCardStatus" NOT NULL DEFAULT 'ACTIVE',
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "isSampleData" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_card_rules" (
    "id" UUID NOT NULL,
    "rateCardId" UUID NOT NULL,
    "ruleType" "RateRuleType" NOT NULL,
    "appliesToPayment" "PaymentType",
    "minWeightGrams" INTEGER,
    "maxWeightGrams" INTEGER,
    "basisPoints" INTEGER,
    "amount" DECIMAL(14,2),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rate_card_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rate_cards_channelSourceId_courierSourceId_status_idx" ON "rate_cards"("channelSourceId", "courierSourceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "rate_cards_channelSourceId_courierSourceId_versionNo_key" ON "rate_cards"("channelSourceId", "courierSourceId", "versionNo");

-- CreateIndex
CREATE INDEX "rate_card_rules_rateCardId_idx" ON "rate_card_rules"("rateCardId");

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_channelSourceId_fkey" FOREIGN KEY ("channelSourceId") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_courierSourceId_fkey" FOREIGN KEY ("courierSourceId") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_card_rules" ADD CONSTRAINT "rate_card_rules_rateCardId_fkey" FOREIGN KEY ("rateCardId") REFERENCES "rate_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
