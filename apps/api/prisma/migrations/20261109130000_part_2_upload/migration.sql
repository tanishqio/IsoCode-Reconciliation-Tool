-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('WEBSITE', 'MARKETPLACE', 'QUICK_COMMERCE', 'COURIER_AGGREGATOR', 'WAREHOUSE');

-- CreateEnum
CREATE TYPE "FileType" AS ENUM ('ORDERS', 'SETTLEMENT', 'COD_REMITTANCE', 'FREIGHT_INVOICE', 'RETURN_SCAN');

-- CreateEnum
CREATE TYPE "FileFormat" AS ENUM ('CSV', 'XLS', 'XLSX');

-- CreateEnum
CREATE TYPE "FileStatus" AS ENUM ('NEEDS_MAPPING', 'QUEUED', 'PROCESSING', 'COMPLETED', 'COMPLETED_WITH_REJECTS', 'FAILED');

-- CreateTable
CREATE TABLE "sources" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "SourceKind" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_file_types" (
    "id" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "fileType" "FileType" NOT NULL,

    CONSTRAINT "source_file_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_batches" (
    "id" UUID NOT NULL,
    "uploadedById" UUID NOT NULL,
    "fileCount" INTEGER NOT NULL,
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upload_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uploaded_files" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "fileType" "FileType" NOT NULL,
    "originalName" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "format" "FileFormat" NOT NULL,
    "sha256" TEXT NOT NULL,
    "headerSignature" TEXT NOT NULL,
    "detectedRowCount" INTEGER,
    "warning" TEXT,
    "status" "FileStatus" NOT NULL DEFAULT 'NEEDS_MAPPING',
    "mappingVersionId" UUID,
    "rowsAccepted" INTEGER,
    "rowsRejected" INTEGER,
    "rowsDuplicate" INTEGER,
    "uploadedById" UUID NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "uploaded_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sources_name_key" ON "sources"("name");

-- CreateIndex
CREATE UNIQUE INDEX "source_file_types_sourceId_fileType_key" ON "source_file_types"("sourceId", "fileType");

-- CreateIndex
CREATE INDEX "upload_batches_createdAt_idx" ON "upload_batches"("createdAt");

-- CreateIndex
CREATE INDEX "uploaded_files_sourceId_fileType_uploadedAt_idx" ON "uploaded_files"("sourceId", "fileType", "uploadedAt");

-- CreateIndex
CREATE INDEX "uploaded_files_status_idx" ON "uploaded_files"("status");

-- CreateIndex
CREATE INDEX "uploaded_files_batchId_idx" ON "uploaded_files"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "uploaded_files_sourceId_fileType_sha256_key" ON "uploaded_files"("sourceId", "fileType", "sha256");

-- AddForeignKey
ALTER TABLE "source_file_types" ADD CONSTRAINT "source_file_types_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_batches" ADD CONSTRAINT "upload_batches_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uploaded_files" ADD CONSTRAINT "uploaded_files_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "upload_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uploaded_files" ADD CONSTRAINT "uploaded_files_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uploaded_files" ADD CONSTRAINT "uploaded_files_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
