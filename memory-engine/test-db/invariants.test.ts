import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { spanFor } from '../src/lib/dating'

const url = process.env.MEMORY_TEST_DATABASE_URL

if (!url && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 but MEMORY_TEST_DATABASE_URL is unset.')
}

const prisma = url
  ? new PrismaClient({ datasources: { db: { url } } })
  : (null as unknown as PrismaClient)

const describeDb = url ? describe : describe.skip

afterAll(async () => {
  if (prisma) await prisma.$disconnect()
})

/** Every insert here is permanent — the point of the suite is that nothing can clean up. */
async function anEpisode(body: string) {
  return prisma.episode.create({
    data: {
      body,
      precision: 'year',
      confidence: 3,
      ...spanFor({ precision: 'year', year: 2014 }),
    },
  })
}

describeDb('the spine is append-only', () => {
  let id: string

  beforeAll(async () => {
    id = (await anEpisode(`append-only probe ${Date.now()}`)).id
  })

  it('refuses an UPDATE through Prisma', async () => {
    await expect(
      prisma.episode.update({ where: { id }, data: { body: 'rewritten' } }),
    ).rejects.toThrow(/append-only/)
  })

  it('refuses an UPDATE in raw SQL, so the ORM is not the guard', async () => {
    await expect(
      prisma.$executeRawUnsafe(`UPDATE episodes SET body = 'rewritten' WHERE id = $1::uuid`, id),
    ).rejects.toThrow(/append-only/)
  })

  it('refuses a DELETE', async () => {
    await expect(prisma.episode.delete({ where: { id } })).rejects.toThrow(/append-only/)
  })

  it('refuses a TRUNCATE, which a row trigger alone would let through', async () => {
    await expect(prisma.$executeRawUnsafe('TRUNCATE episodes CASCADE')).rejects.toThrow(
      /append-only/,
    )
  })

  it('leaves the row exactly as it was written', async () => {
    const row = await prisma.episode.findUniqueOrThrow({ where: { id } })
    expect(row.body).toMatch(/^append-only probe /)
  })
})

describeDb('the dating contract', () => {
  const insert = (values: string) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO episodes (id, body, occurred_at, occurred_end, precision, confidence)
       VALUES (gen_random_uuid(), ${values})`,
    )

  it('will not let an unplaceable episode carry a date', async () => {
    await expect(insert(`'x', '2014-01-01', '2014-01-01', 'unknown', NULL`)).rejects.toThrow(
      /episodes_precision_dating/,
    )
  })

  it('will not let a dated episode skip its confidence', async () => {
    await expect(insert(`'x', '2014-01-01', '2014-12-31', 'year', NULL`)).rejects.toThrow(
      /episodes_precision_dating/,
    )
  })

  it('will not let a span run backwards', async () => {
    await expect(insert(`'x', '2014-12-31', '2014-01-01', 'year', 3`)).rejects.toThrow(
      /episodes_precision_dating/,
    )
  })

  it('holds a day-precision episode to exactly one day', async () => {
    await expect(insert(`'x', '2014-01-01', '2014-12-31', 'day', 5`)).rejects.toThrow(
      /episodes_day_precision_is_one_day/,
    )
  })

  it('holds confidence to 1–5', async () => {
    await expect(insert(`'x', '2014-01-01', '2014-12-31', 'year', 9`)).rejects.toThrow(
      /episodes_confidence_range/,
    )
  })

  it('refuses an episode with no text', async () => {
    await expect(insert(`'   ', NULL, NULL, 'unknown', NULL`)).rejects.toThrow(
      /episodes_body_not_blank/,
    )
  })
})

describeDb('interpretation supersedes, never overwrites', () => {
  let episodeId: string

  beforeAll(async () => {
    episodeId = (await anEpisode(`annotation probe ${Date.now()}`)).id
  })

  it('keeps a satellite from burying what another lens said', async () => {
    const first = await prisma.annotation.create({
      data: { episodeId, namespace: 'self', body: 'first reading', author: 'user' },
    })

    await expect(
      prisma.annotation.create({
        data: {
          episodeId,
          namespace: 'jung',
          body: 'a different lens, reaching across',
          author: 'ai',
          supersedes: first.id,
        },
      }),
    ).rejects.toThrow(/same episode and namespace/)
  })

  it('allows a later reading within the same lens, and keeps the earlier one', async () => {
    const first = await prisma.annotation.create({
      data: { episodeId, namespace: 'schema', body: 'as it looked in 2026', author: 'user' },
    })
    const second = await prisma.annotation.create({
      data: {
        episodeId,
        namespace: 'schema',
        body: 'as it looks in 2030',
        author: 'user',
        supersedes: first.id,
      },
    })

    const both = await prisma.annotation.findMany({
      where: { episodeId, namespace: 'schema' },
      orderBy: { writtenAt: 'asc' },
    })
    expect(both.map((row) => row.id)).toEqual([first.id, second.id])
    expect(both[0].body).toBe('as it looked in 2026')
  })

  it('will not fork a chain: an annotation is superseded at most once', async () => {
    const first = await prisma.annotation.create({
      data: { episodeId, namespace: 'fork', body: 'original', author: 'user' },
    })
    await prisma.annotation.create({
      data: { episodeId, namespace: 'fork', body: 'revision', author: 'user', supersedes: first.id },
    })

    await expect(
      prisma.annotation.create({
        data: { episodeId, namespace: 'fork', body: 'rival revision', author: 'user', supersedes: first.id },
      }),
    ).rejects.toThrow()
  })

  it('refuses to edit or delete an annotation once written', async () => {
    const written = await prisma.annotation.create({
      data: { episodeId, namespace: 'immutable', body: 'said once', author: 'user' },
    })
    await expect(
      prisma.annotation.update({ where: { id: written.id }, data: { body: 'unsaid' } }),
    ).rejects.toThrow(/append-only/)
    await expect(prisma.annotation.delete({ where: { id: written.id } })).rejects.toThrow(
      /append-only/,
    )
  })
})
