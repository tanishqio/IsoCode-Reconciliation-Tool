-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('SETTLED', 'SHORT_PAID', 'OVERPAID', 'UNPAID_PAST_DUE', 'FREIGHT_OVERCHARGED', 'RETURN_NOT_RECEIVED', 'PENDING', 'NOT_TRACKED', 'CANNOT_CALCULATE');

-- CreateEnum
CREATE TYPE "MatchMethod" AS ENUM ('EXACT', 'NONE');

-- CreateTable
CREATE TABLE "order_results" (
    "id" UUID NOT NULL,
    "orderPk" UUID NOT NULL,
    "jobId" UUID,
    "rateCardId" UUID,
    "rateCardVersionNo" INTEGER,
    "expected" DECIMAL(14,2),
    "settlementNet" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tcs" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tds" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "codRemitted" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "returnFreight" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "received" DECIMAL(14,2),
    "difference" DECIMAL(14,2),
    "freightExpected" DECIMAL(14,2),
    "freightBilled" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "OrderStatus" NOT NULL,
    "flags" JSONB NOT NULL,
    "calcProblem" TEXT,
    "matchMethod" "MatchMethod" NOT NULL,
    "lineCounts" JSONB NOT NULL,
    "dueDate" TIMESTAMP(3),
    "asOf" TIMESTAMP(3) NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "tolerance" DECIMAL(14,2) NOT NULL DEFAULT 10,
    "codDueDays" INTEGER NOT NULL DEFAULT 7,
    "settlementDueDays" INTEGER NOT NULL DEFAULT 14,
    "returnWindowDays" INTEGER NOT NULL DEFAULT 7,
    "isSampleData" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reconciliation_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_results_orderPk_key" ON "order_results"("orderPk");

-- CreateIndex
CREATE INDEX "order_results_status_idx" ON "order_results"("status");

-- CreateIndex
CREATE INDEX "order_results_difference_idx" ON "order_results"("difference");

-- CreateIndex
CREATE INDEX "order_results_computedAt_idx" ON "order_results"("computedAt");

-- CreateIndex
CREATE INDEX "customer_orders_orderId_idx" ON "customer_orders"("orderId");

-- AddForeignKey
ALTER TABLE "order_results" ADD CONSTRAINT "order_results_orderPk_fkey" FOREIGN KEY ("orderPk") REFERENCES "customer_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The one row of reconciliation settings. The numbers are sample values (the assignment gives none).
INSERT INTO "reconciliation_settings" ("id", "updatedAt") VALUES (1, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING;
