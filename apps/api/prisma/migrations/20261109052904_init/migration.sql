-- CreateEnum
CREATE TYPE "Role" AS ENUM ('FINANCE_EXECUTIVE', 'CO_FOUNDER');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('INGEST_FILE', 'RECOMPUTE_RESULTS', 'BUILD_CLAIMS');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_jobs" (
    "id" UUID NOT NULL,
    "type" "JobType" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID,
    "params" JSONB,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "stage" TEXT,
    "progressPct" INTEGER NOT NULL DEFAULT 0,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "heartbeatAt" TIMESTAMP(3),
    "stageTimingsMs" JSONB,
    "errorMessage" TEXT,
    "createdById" UUID NOT NULL,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "processing_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "processing_jobs_status_queuedAt_idx" ON "processing_jobs"("status", "queuedAt");

-- CreateIndex
CREATE INDEX "processing_jobs_entityType_entityId_idx" ON "processing_jobs"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
