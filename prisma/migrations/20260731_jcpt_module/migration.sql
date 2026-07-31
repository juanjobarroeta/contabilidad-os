-- JCPT (coaching platform) as a satellite module: gate for the external
-- income ingest and future ledger postings.

-- AlterEnum
ALTER TYPE "ModuloApp" ADD VALUE 'JCPT';

-- AlterEnum
ALTER TYPE "EntrySource" ADD VALUE 'JCPT';
