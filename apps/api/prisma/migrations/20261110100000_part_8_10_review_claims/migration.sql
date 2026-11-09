-- CreateEnum
CREATE TYPE "LineKind" AS ENUM ('SETTLEMENT', 'COD_REMITTANCE', 'FREIGHT', 'RETURN_SCAN');

-- CreateEnum
CREATE TYPE "SuggestionOrigin" AS ENUM ('RULES', 'AI');

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ClaimType" AS ENUM ('SHORT_PAID', 'UNPAID', 'FREIGHT_OVERCHARGE', 'RETURN_NOT_RECEIVED');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('OPEN', 'EXPORTED', 'RECOVERED', 'CLOSED');

-- AlterEnum
ALTER TYPE "JobType" ADD VALUE 'SUGGEST_MATCHES';

-- AlterEnum
ALTER TYPE "MatchMethod" ADD VALUE 'REVIEW_ACCEPTED';

-- CreateTable
CREATE TABLE "match_suggestions" (
    "id" UUID NOT NULL,
    "lineKind" "LineKind" NOT NULL,
    "lineId" UUID NOT NULL,
    "candidateOrderPk" UUID NOT NULL,
    "score" INTEGER NOT NULL,
    "reasons" JSONB NOT NULL,
    "origin" "SuggestionOrigin" NOT NULL,
    "aiModel" TEXT,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "jobId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claims" (
    "id" UUID NOT NULL,
    "claimNo" SERIAL NOT NULL,
    "partnerSourceId" UUID NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'OPEN',
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "recovered" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "exportedAt" TIMESTAMP(3),
    "exportedById" UUID,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_items" (
    "id" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "orderPk" UUID NOT NULL,
    "claimType" "ClaimType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "ageBasisDate" TIMESTAMP(3) NOT NULL,
    "ageDays" INTEGER NOT NULL,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "match_suggestions_status_score_idx" ON "match_suggestions"("status", "score");

-- CreateIndex
CREATE INDEX "match_suggestions_lineKind_lineId_idx" ON "match_suggestions"("lineKind", "lineId");

-- CreateIndex
CREATE UNIQUE INDEX "match_suggestions_lineKind_lineId_candidateOrderPk_key" ON "match_suggestions"("lineKind", "lineId", "candidateOrderPk");

-- CreateIndex
CREATE UNIQUE INDEX "claims_claimNo_key" ON "claims"("claimNo");

-- CreateIndex
CREATE INDEX "claims_partnerSourceId_status_idx" ON "claims"("partnerSourceId", "status");

-- CreateIndex
CREATE INDEX "claims_status_idx" ON "claims"("status");

-- CreateIndex
CREATE INDEX "claim_items_claimId_idx" ON "claim_items"("claimId");

-- CreateIndex
CREATE UNIQUE INDEX "claim_items_orderPk_claimType_key" ON "claim_items"("orderPk", "claimType");

-- AddForeignKey
ALTER TABLE "match_suggestions" ADD CONSTRAINT "match_suggestions_candidateOrderPk_fkey" FOREIGN KEY ("candidateOrderPk") REFERENCES "customer_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_suggestions" ADD CONSTRAINT "match_suggestions_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_partnerSourceId_fkey" FOREIGN KEY ("partnerSourceId") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_exportedById_fkey" FOREIGN KEY ("exportedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_items" ADD CONSTRAINT "claim_items_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_items" ADD CONSTRAINT "claim_items_orderPk_fkey" FOREIGN KEY ("orderPk") REFERENCES "customer_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
