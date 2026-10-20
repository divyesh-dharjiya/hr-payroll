-- CreateTable
CREATE TABLE "AttendancePunch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "attendanceRecordId" TEXT NOT NULL,
    "inAt" TIMESTAMP(3) NOT NULL,
    "outAt" TIMESTAMP(3),
    "autoClosed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendancePunch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttendancePunch_employeeId_inAt_idx" ON "AttendancePunch"("employeeId", "inAt");

-- CreateIndex
CREATE INDEX "AttendancePunch_attendanceRecordId_idx" ON "AttendancePunch"("attendanceRecordId");

-- AddForeignKey
ALTER TABLE "AttendancePunch" ADD CONSTRAINT "AttendancePunch_attendanceRecordId_fkey" FOREIGN KEY ("attendanceRecordId") REFERENCES "AttendanceRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePunch" ADD CONSTRAINT "AttendancePunch_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most one open (not yet punched-out) session per employee. Blocks double punch-ins from concurrent requests.
CREATE UNIQUE INDEX "AttendancePunch_one_open_per_employee" ON "AttendancePunch"("employeeId") WHERE "outAt" IS NULL;
