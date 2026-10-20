-- CreateEnum
CREATE TYPE "OvertimeStatus" AS ENUM ('NONE', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DocumentCategory" AS ENUM ('ID_PROOF', 'ADDRESS_PROOF', 'EDUCATION', 'EMPLOYMENT', 'CONTRACT', 'TAX', 'OTHER');

-- AlterTable
ALTER TABLE "AttendanceRecord" ADD COLUMN     "overtimeApprovedMinutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "overtimeComment" TEXT,
ADD COLUMN     "overtimeReviewedAt" TIMESTAMP(3),
ADD COLUMN     "overtimeReviewerId" TEXT,
ADD COLUMN     "overtimeStatus" "OvertimeStatus" NOT NULL DEFAULT 'NONE';

-- CreateTable
CREATE TABLE "EmployeeDocument" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "category" "DocumentCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageName" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeDocument_storageName_key" ON "EmployeeDocument"("storageName");

-- CreateIndex
CREATE INDEX "EmployeeDocument_organizationId_employeeId_idx" ON "EmployeeDocument"("organizationId", "employeeId");

-- CreateIndex
CREATE INDEX "AttendanceRecord_organizationId_overtimeStatus_idx" ON "AttendanceRecord"("organizationId", "overtimeStatus");

-- AddForeignKey
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
