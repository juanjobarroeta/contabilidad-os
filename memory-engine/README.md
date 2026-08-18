# Memory Engine

A personal autobiographical archive: episodes you write, dated as precisely (or
as vaguely) as you actually remember them, kept forever.

**This is not part of contabilidad-os.** It shares the repository and nothing
else — its own `package.json`, its own `node_modules`, its own Prisma schema,
its own `DATABASE_URL`, and no import that crosses into `../src`. That
separation is the point; see [Legal posture](#legal-posture).

Phase 1 of the build outline is what is here: the episode store, uncertain
dating, the write form, the year-grouped reading surface, and the markdown
export. No AI, no retrieval, no entity extraction yet.

## Running it

```bash
cd memory-engine
npm install
cp .env.example .env          # point DATABASE_URL at a database of its own
npx prisma migrate deploy
npx prisma generate
npm run dev                   # http://localhost:3100
```

```bash
npm test                      # pure logic, no database needed
npm run test:db               # the invariants, against a real Postgres
npm run export                # the whole archive as plain markdown
```

Needs Postgres 13+ (`gen_random_uuid()` is built in from 13). **No pgvector** —
see [Embeddings](#embeddings-are-not-here-yet).

## What the schema is doing

Six tables, all created in the first migration even though Phase 1 writes to
only one. Migrating an append-only store later is the expensive move; the
columns cost nothing while they sit empty.

| Table | Holds | Written in Phase 1 |
| --- | --- | --- |
| `episodes` | the immutable spine — what happened, when, how sure | yes |
| `entities` | people, places, periods, things | no (Phase 3) |
| `entity_aliases` | the four names one person goes by | no (Phase 3) |
| `episode_entities` | who was `present`, `mentioned`, `about` | no (Phase 3) |
| `annotations` | interpretation, namespaced per lens, superseding | no (deferred) |
| `media` | photos; unlinked rows are the backfill queue | no (Phase 4) |

### Uncertain dating

Half of an archive like this is "sometime in 2014". A single nullable date
forces false precision, and false precision is what makes you stop logging. So
every episode carries a `precision` and a **closed span**:

| precision | span | rendered as |
| --- | --- | --- |
| `day` | one day | `July 12, 2014` |
| `month` | first to last of the month | `July 2014` |
| `season` | three months | `Winter 2014 (Dec 2013 – Feb 2014)` |
| `year` | Jan 1 – Dec 31 | `2014` |
| `unknown` | no span at all | `Undated` |

The span is always **derived** from the precision, never typed by hand, and the
database refuses rows where the two disagree — a `day` that covers a year, a
`year` with no confidence, an `unknown` carrying a date.

Seasons are meteorological and northern-hemisphere, named for the year they
*end* in: winter 2014 is December 2013 through February 2014. Every label
spells the range out so nobody has to remember which convention was chosen, and
episodes file under the year at the **middle** of their span, which puts that
winter with the 2014 it belongs to instead of a scroll away in 2013.

### Append-only, enforced by Postgres

`episodes` and `annotations` reject `UPDATE`, `DELETE` **and `TRUNCATE`** at the
database. Not a convention, not a code-review rule — the triggers are in
[the first migration](prisma/migrations/20260818000000_init/migration.sql), and
`npm run test:db` proves all three, through Prisma and through raw SQL.

A correction is a new episode. A changed reading is a new annotation that
`supersedes` the old one, and the old one stays. Reading how your reading of
2019 shifted between 2026 and 2030 is the whole reason that column exists.

An annotation may only supersede one on the **same episode in the same
namespace**, so a future `jung` lens can never bury what the `self` lens said.

### Embeddings are not here yet

The outline put `embedding vector(1536)` on `episodes` and also said to keep
embeddings in a separate table so a later move to client-side encryption never
has to touch the spine. Both cannot be true. The spine wins: embeddings arrive
in Phase 2 as `episode_embeddings`, and Phase 1 runs on plain Postgres.

### Deviations from the outline, in full

- Embeddings moved off `episodes`, as above.
- `media.exif_gps point` became `exif_gps_lat` / `exif_gps_lon`; Prisma has no
  point type and the pair indexes better anyway.
- `confidence` is null exactly when precision is `unknown` — asking how sure you
  are of a date you do not have is asking nothing.
- Episodes may not *start* in the future. A span may still be open at its far
  end: the current year runs to December 31 and that is fine, you are living
  inside the band.

## Export

`npm run export [dir]` writes one markdown file per episode, in year folders,
with YAML frontmatter, plus a `README.md` index:

```
export/
  README.md
  2014/2013-12-01--season--0874a959.md
  2014/2014-07-12--day--d3a1f378.md
  2021/2021-01-01--year--2c85c313.md
  undated/2026-08-18--unknown--3bd3cb3e.md
```

The file name carries the precision, so a whole-year episode is never read back
as something that happened on January 1st. Entities, media and annotation
layers are rendered too, not only what Phase 1 writes, so the exporter will not
quietly start dropping data the day those get populated.

The realistic way to lose an archive like this is not a disk failure, it is a
schema migration in year four. Run it often; commit the output somewhere.

## Legal posture

Personal and domestic use with no disclosure purpose sits outside LFPDPPP's
scope (Art. 2). That holds only while this stays single-user, unshared, with no
public surface, no export to third parties, and no second person's account.

Which is why there is no `user_id` column to flip on. A future multi-user
satellite is a **separate service against a separate database**, and it inherits
express-consent obligations for *datos personales sensibles* the moment it
exists. Do not point `DATABASE_URL` at the contabilidad-os database.

## Next

Phase 2 is the retrieval API — temporal, entity, semantic, combined — and the
outline is right that it should be frozen early, because every later surface
consumes it. Phase 1 is meant to be lived in first: thirty episodes by hand,
then decide whether this model is the right one.
