-- CreateEnum
CREATE TYPE "MappingOrigin" AS ENUM ('AI', 'FALLBACK', 'MANUAL');

-- CreateEnum
CREATE TYPE "MappingStatus" AS ENUM ('PROPOSED', 'ACTIVE', 'SUPERSEDED', 'REJECTED');

-- CreateTable
CREATE TABLE "mapping_versions" (
    "id" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "fileType" "FileType" NOT NULL,
    "versionNo" INTEGER,
    "headerSignature" TEXT NOT NULL,
    "columnMap" JSONB NOT NULL,
    "ignoredColumns" JSONB NOT NULL,
    "fieldInfo" JSONB,
    "notes" JSONB,
    "origin" "MappingOrigin" NOT NULL,
    "aiModel" TEXT,
    "status" "MappingStatus" NOT NULL,
    "rolledBackFromId" UUID,
    "createdById" UUID NOT NULL,
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mapping_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mapping_versions_sourceId_fileType_status_idx" ON "mapping_versions"("sourceId", "fileType", "status");

-- CreateIndex
CREATE INDEX "mapping_versions_headerSignature_idx" ON "mapping_versions"("headerSignature");

-- CreateIndex
CREATE UNIQUE INDEX "mapping_versions_sourceId_fileType_versionNo_key" ON "mapping_versions"("sourceId", "fileType", "versionNo");

-- AddForeignKey
ALTER TABLE "uploaded_files" ADD CONSTRAINT "uploaded_files_mappingVersionId_fkey" FOREIGN KEY ("mappingVersionId") REFERENCES "mapping_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mapping_versions" ADD CONSTRAINT "mapping_versions_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mapping_versions" ADD CONSTRAINT "mapping_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mapping_versions" ADD CONSTRAINT "mapping_versions_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Only one ACTIVE mapping per source and file type (a partial index; Prisma cannot express it).
CREATE UNIQUE INDEX "mapping_versions_one_active_per_source_type"
  ON "mapping_versions" ("sourceId", "fileType")
  WHERE "status" = 'ACTIVE';
