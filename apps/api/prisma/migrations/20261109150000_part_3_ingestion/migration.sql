-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('COD', 'PREPAID');

-- CreateEnum
CREATE TYPE "ChargeType" AS ENUM ('FORWARD', 'REVERSE', 'COD_FEE', 'OTHER');

-- CreateEnum
CREATE TYPE "LineMatchStatus" AS ENUM ('UNMATCHED', 'EXACT', 'SUGGESTED', 'ACCEPTED');

-- CreateTable
CREATE TABLE "customer_orders" (
    "id" UUID NOT NULL,
    "sourceFileId" UUID NOT NULL,
    "sourceRowNumber" INTEGER NOT NULL,
    "rowHash" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "channelSourceId" UUID NOT NULL,
    "orderDate" TIMESTAMP(3) NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "paymentType" "PaymentType" NOT NULL,
    "deliveryStatus" TEXT NOT NULL,
    "awb" TEXT,
    "courierSourceId" UUID,
    "weightGrams" INTEGER,
    "deliveredAt" TIMESTAMP(3),
    "returnedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_lines" (
    "id" UUID NOT NULL,
    "sourceFileId" UUID NOT NULL,
    "sourceRowNumber" INTEGER NOT NULL,
    "rowHash" TEXT NOT NULL,
    "orderIdRaw" TEXT,
    "orderPk" UUID,
    "matchStatus" "LineMatchStatus" NOT NULL DEFAULT 'UNMATCHED',
    "sourceId" UUID NOT NULL,
    "lineRef" TEXT,
    "settledOn" TIMESTAMP(3) NOT NULL,
    "lineType" TEXT NOT NULL,
    "netReceived" DECIMAL(14,2) NOT NULL,
    "tcs" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tds" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "otherDeductions" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cod_remittance_lines" (
    "id" UUID NOT NULL,
    "sourceFileId" UUID NOT NULL,
    "sourceRowNumber" INTEGER NOT NULL,
    "rowHash" TEXT NOT NULL,
    "orderIdRaw" TEXT,
    "orderPk" UUID,
    "matchStatus" "LineMatchStatus" NOT NULL DEFAULT 'UNMATCHED',
    "aggregatorSourceId" UUID NOT NULL,
    "awb" TEXT,
    "remittanceRef" TEXT,
    "remittedOn" TIMESTAMP(3) NOT NULL,
    "remittedAmount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cod_remittance_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "freight_lines" (
    "id" UUID NOT NULL,
    "sourceFileId" UUID NOT NULL,
    "sourceRowNumber" INTEGER NOT NULL,
    "rowHash" TEXT NOT NULL,
    "orderIdRaw" TEXT,
    "orderPk" UUID,
    "matchStatus" "LineMatchStatus" NOT NULL DEFAULT 'UNMATCHED',
    "aggregatorSourceId" UUID NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "awb" TEXT,
    "chargeType" "ChargeType" NOT NULL,
    "billedWeightGrams" INTEGER,
    "billedAmount" DECIMAL(14,2) NOT NULL,
    "chargedOn" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "freight_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_scans" (
    "id" UUID NOT NULL,
    "sourceFileId" UUID NOT NULL,
    "sourceRowNumber" INTEGER NOT NULL,
    "rowHash" TEXT NOT NULL,
    "orderIdRaw" TEXT,
    "orderPk" UUID,
    "matchStatus" "LineMatchStatus" NOT NULL DEFAULT 'UNMATCHED',
    "warehouseSourceId" UUID NOT NULL,
    "awb" TEXT,
    "scannedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "return_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rejected_rows" (
    "id" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "rawSnippet" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rejected_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_orders_sourceFileId_idx" ON "customer_orders"("sourceFileId");

-- CreateIndex
CREATE INDEX "customer_orders_awb_idx" ON "customer_orders"("awb");

-- CreateIndex
CREATE UNIQUE INDEX "customer_orders_channelSourceId_orderId_key" ON "customer_orders"("channelSourceId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_lines_rowHash_key" ON "settlement_lines"("rowHash");

-- CreateIndex
CREATE INDEX "settlement_lines_sourceFileId_idx" ON "settlement_lines"("sourceFileId");

-- CreateIndex
CREATE INDEX "settlement_lines_orderIdRaw_idx" ON "settlement_lines"("orderIdRaw");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_lines_sourceId_lineRef_key" ON "settlement_lines"("sourceId", "lineRef");

-- CreateIndex
CREATE UNIQUE INDEX "cod_remittance_lines_rowHash_key" ON "cod_remittance_lines"("rowHash");

-- CreateIndex
CREATE INDEX "cod_remittance_lines_sourceFileId_idx" ON "cod_remittance_lines"("sourceFileId");

-- CreateIndex
CREATE INDEX "cod_remittance_lines_orderIdRaw_idx" ON "cod_remittance_lines"("orderIdRaw");

-- CreateIndex
CREATE INDEX "cod_remittance_lines_awb_idx" ON "cod_remittance_lines"("awb");

-- CreateIndex
CREATE UNIQUE INDEX "cod_remittance_lines_aggregatorSourceId_remittanceRef_awb_key" ON "cod_remittance_lines"("aggregatorSourceId", "remittanceRef", "awb");

-- CreateIndex
CREATE UNIQUE INDEX "freight_lines_rowHash_key" ON "freight_lines"("rowHash");

-- CreateIndex
CREATE INDEX "freight_lines_sourceFileId_idx" ON "freight_lines"("sourceFileId");

-- CreateIndex
CREATE INDEX "freight_lines_orderIdRaw_idx" ON "freight_lines"("orderIdRaw");

-- CreateIndex
CREATE INDEX "freight_lines_awb_idx" ON "freight_lines"("awb");

-- CreateIndex
CREATE UNIQUE INDEX "return_scans_rowHash_key" ON "return_scans"("rowHash");

-- CreateIndex
CREATE INDEX "return_scans_sourceFileId_idx" ON "return_scans"("sourceFileId");

-- CreateIndex
CREATE INDEX "return_scans_orderIdRaw_idx" ON "return_scans"("orderIdRaw");

-- CreateIndex
CREATE INDEX "return_scans_awb_idx" ON "return_scans"("awb");

-- CreateIndex
CREATE INDEX "rejected_rows_fileId_rowNumber_idx" ON "rejected_rows"("fileId", "rowNumber");

-- AddForeignKey
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "uploaded_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_channelSourceId_fkey" FOREIGN KEY ("channelSourceId") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_courierSourceId_fkey" FOREIGN KEY ("courierSourceId") REFERENCES "sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "uploaded_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_remittance_lines" ADD CONSTRAINT "cod_remittance_lines_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "uploaded_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_remittance_lines" ADD CONSTRAINT "cod_remittance_lines_aggregatorSourceId_fkey" FOREIGN KEY ("aggregatorSourceId") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freight_lines" ADD CONSTRAINT "freight_lines_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "uploaded_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freight_lines" ADD CONSTRAINT "freight_lines_aggregatorSourceId_fkey" FOREIGN KEY ("aggregatorSourceId") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_scans" ADD CONSTRAINT "return_scans_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "uploaded_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_scans" ADD CONSTRAINT "return_scans_warehouseSourceId_fkey" FOREIGN KEY ("warehouseSourceId") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rejected_rows" ADD CONSTRAINT "rejected_rows_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "uploaded_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
