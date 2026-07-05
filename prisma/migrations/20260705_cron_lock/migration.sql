-- CreateTable
CREATE TABLE "CronLock" (
    "job" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CronLock_pkey" PRIMARY KEY ("job")
);
