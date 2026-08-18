-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Precision" AS ENUM ('day', 'month', 'season', 'year', 'unknown');

-- CreateEnum
CREATE TYPE "Source" AS ENUM ('typed', 'photo_prompt', 'import');

-- CreateEnum
CREATE TYPE "EntityKind" AS ENUM ('person', 'place', 'period', 'thing');

-- CreateEnum
CREATE TYPE "EpisodeRole" AS ENUM ('present', 'mentioned', 'about');

-- CreateEnum
CREATE TYPE "AnnotationAuthor" AS ENUM ('user', 'ai');

-- CreateTable
CREATE TABLE "episodes" (
    "id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "occurred_at" DATE,
    "occurred_end" DATE,
    "precision" "Precision" NOT NULL,
    "confidence" SMALLINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "Source" NOT NULL DEFAULT 'typed',

    CONSTRAINT "episodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entities" (
    "id" UUID NOT NULL,
    "kind" "EntityKind" NOT NULL,
    "canonical_name" TEXT NOT NULL,
    "first_seen" DATE,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_aliases" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "alias" TEXT NOT NULL,

    CONSTRAINT "entity_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "episode_entities" (
    "episode_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "role" "EpisodeRole" NOT NULL,

    CONSTRAINT "episode_entities_pkey" PRIMARY KEY ("episode_id","entity_id","role")
);

-- CreateTable
CREATE TABLE "annotations" (
    "id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "namespace" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "written_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersedes" UUID,
    "author" "AnnotationAuthor" NOT NULL,

    CONSTRAINT "annotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media" (
    "id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "exif_taken_at" TIMESTAMPTZ(6),
    "exif_gps_lat" DOUBLE PRECISION,
    "exif_gps_lon" DOUBLE PRECISION,
    "episode_id" UUID,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "episodes_occurred_at_idx" ON "episodes"("occurred_at");

-- CreateIndex
CREATE INDEX "episodes_occurred_at_occurred_end_idx" ON "episodes"("occurred_at", "occurred_end");

-- CreateIndex
CREATE INDEX "episodes_created_at_idx" ON "episodes"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "entities_kind_canonical_name_key" ON "entities"("kind", "canonical_name");

-- CreateIndex
CREATE INDEX "entity_aliases_alias_idx" ON "entity_aliases"("alias");

-- CreateIndex
CREATE UNIQUE INDEX "entity_aliases_entity_id_alias_key" ON "entity_aliases"("entity_id", "alias");

-- CreateIndex
CREATE INDEX "episode_entities_entity_id_idx" ON "episode_entities"("entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "annotations_supersedes_key" ON "annotations"("supersedes");

-- CreateIndex
CREATE INDEX "annotations_episode_id_namespace_idx" ON "annotations"("episode_id", "namespace");

-- CreateIndex
CREATE INDEX "annotations_namespace_written_at_idx" ON "annotations"("namespace", "written_at");

-- CreateIndex
CREATE UNIQUE INDEX "media_path_key" ON "media"("path");

-- CreateIndex
CREATE INDEX "media_exif_taken_at_idx" ON "media"("exif_taken_at");

-- CreateIndex
CREATE INDEX "media_processed_exif_taken_at_idx" ON "media"("processed", "exif_taken_at");

-- AddForeignKey
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "episode_entities" ADD CONSTRAINT "episode_entities_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "episodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "episode_entities" ADD CONSTRAINT "episode_entities_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "episodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_supersedes_fkey" FOREIGN KEY ("supersedes") REFERENCES "annotations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media" ADD CONSTRAINT "media_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "episodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Invariants Prisma cannot express. Everything below is hand-written and is
-- the reason this migration is checked in rather than generated on the fly.
-- ─────────────────────────────────────────────────────────────────────────────

-- An episode with no text is a row that will never mean anything later.
ALTER TABLE "episodes"
  ADD CONSTRAINT "episodes_body_not_blank" CHECK (length(btrim("body")) > 0);

-- Confidence is about the DATING, on a 1–5 scale.
ALTER TABLE "episodes"
  ADD CONSTRAINT "episodes_confidence_range"
  CHECK ("confidence" IS NULL OR "confidence" BETWEEN 1 AND 5);

-- The dating contract, in one place:
--   precision = 'unknown' -> no span at all, and no confidence to state.
--   anything else         -> a closed, ordered span. A year-precision episode
--                            is Jan 1 .. Dec 31, never a point on Jan 1.
-- This is what stops the archive from drifting into false precision the first
-- time someone writes a bare date with a coarse precision beside it.
ALTER TABLE "episodes"
  ADD CONSTRAINT "episodes_precision_dating" CHECK (
    ("precision" = 'unknown'
      AND "occurred_at" IS NULL AND "occurred_end" IS NULL AND "confidence" IS NULL)
    OR
    ("precision" <> 'unknown'
      AND "occurred_at" IS NOT NULL AND "occurred_end" IS NOT NULL
      AND "occurred_end" >= "occurred_at"
      AND "confidence" IS NOT NULL)
  );

-- A day-precision episode spans exactly one day. Without this, 'day' would be
-- a label you could attach to a three-year band.
ALTER TABLE "episodes"
  ADD CONSTRAINT "episodes_day_precision_is_one_day"
  CHECK ("precision" <> 'day' OR "occurred_at" = "occurred_end");

-- ── Append-only: the spine ───────────────────────────────────────────────────
-- Not a convention, not a code review rule — the database refuses. Corrections
-- are new episodes or annotations. TRUNCATE is covered too, because a row-level
-- trigger alone would let one careless statement take the whole archive.
CREATE OR REPLACE FUNCTION "memory_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is refused: this table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation',
          HINT = 'Write a new row instead. Episodes are corrected by later episodes; interpretations by superseding annotations.';
END;
$$;

CREATE TRIGGER "episodes_no_update" BEFORE UPDATE ON "episodes"
  FOR EACH ROW EXECUTE FUNCTION "memory_append_only"();
CREATE TRIGGER "episodes_no_delete" BEFORE DELETE ON "episodes"
  FOR EACH ROW EXECUTE FUNCTION "memory_append_only"();
CREATE TRIGGER "episodes_no_truncate" BEFORE TRUNCATE ON "episodes"
  FOR EACH STATEMENT EXECUTE FUNCTION "memory_append_only"();

-- ── Append-only: interpretation ──────────────────────────────────────────────
-- Superseding, never overwriting. The whole point of the annotation table is to
-- be able to read how your reading changed; an UPDATE erases exactly that.
CREATE TRIGGER "annotations_no_update" BEFORE UPDATE ON "annotations"
  FOR EACH ROW EXECUTE FUNCTION "memory_append_only"();
CREATE TRIGGER "annotations_no_delete" BEFORE DELETE ON "annotations"
  FOR EACH ROW EXECUTE FUNCTION "memory_append_only"();
CREATE TRIGGER "annotations_no_truncate" BEFORE TRUNCATE ON "annotations"
  FOR EACH STATEMENT EXECUTE FUNCTION "memory_append_only"();

-- Satellites cannot reach across each other. An annotation may only supersede
-- one written about the SAME episode in the SAME namespace, so the 'jung' lens
-- can never bury what the 'self' lens said.
CREATE OR REPLACE FUNCTION "annotations_supersede_within_lens"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE prior RECORD;
BEGIN
  IF NEW."supersedes" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."supersedes" = NEW."id" THEN
    RAISE EXCEPTION 'an annotation cannot supersede itself'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "episode_id", "namespace" INTO prior
    FROM "annotations" WHERE "id" = NEW."supersedes";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'superseded annotation % does not exist', NEW."supersedes"
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF prior."episode_id" <> NEW."episode_id" OR prior."namespace" <> NEW."namespace" THEN
    RAISE EXCEPTION 'an annotation may only supersede one on the same episode and namespace (tried % / % over % / %)',
      NEW."episode_id", NEW."namespace", prior."episode_id", prior."namespace"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "annotations_supersede_within_lens_trg" BEFORE INSERT ON "annotations"
  FOR EACH ROW EXECUTE FUNCTION "annotations_supersede_within_lens"();
