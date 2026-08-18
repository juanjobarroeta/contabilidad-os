import { describe, expect, it } from 'vitest'
import {
  exportPath,
  renderEpisode,
  renderExport,
  renderIndex,
  type ExportEpisode,
} from '../src/lib/export-markdown'
import { spanFor } from '../src/lib/dating'

const base: ExportEpisode = {
  id: 'b0253794-873d-4c4e-8f52-971141b7a703',
  body: 'We drove to the coast and the car overheated outside Tecolutla.',
  ...spanFor({ precision: 'day', year: 2014, month: 7, day: 12 }),
  precision: 'day',
  confidence: 4,
  createdAt: new Date('2026-08-18T03:54:47.579Z'),
  source: 'typed',
  entities: [],
  annotations: [],
  media: [],
}

describe('exportPath', () => {
  it('files by year and sorts chronologically inside it', () => {
    expect(exportPath(base)).toBe('2014/2014-07-12--day--b0253794.md')
  })

  it('keeps precision in the name so a year is never read as a January 1st', () => {
    const year: ExportEpisode = {
      ...base,
      precision: 'year',
      ...spanFor({ precision: 'year', year: 2014 }),
    }
    expect(exportPath(year)).toBe('2014/2014-01-01--year--b0253794.md')
  })

  it('gives undated episodes a folder instead of hiding them at 1970', () => {
    const undated: ExportEpisode = {
      ...base,
      precision: 'unknown',
      confidence: null,
      ...spanFor({ precision: 'unknown' }),
    }
    expect(exportPath(undated)).toBe('undated/2026-08-18--unknown--b0253794.md')
  })
})

describe('renderEpisode', () => {
  it('writes frontmatter a human and a script can both read', () => {
    const { contents } = renderEpisode(base)
    expect(contents).toContain('id: b0253794-873d-4c4e-8f52-971141b7a703')
    expect(contents).toContain('occurred_at: 2014-07-12')
    expect(contents).toContain('occurred_end: 2014-07-12')
    expect(contents).toContain('precision: day')
    expect(contents).toContain('confidence: 4')
    expect(contents).toContain('source: typed')
    expect(contents).toContain('# July 12, 2014')
    expect(contents).toContain('outside Tecolutla')
  })

  it('renders an absent date as a YAML null rather than an empty string', () => {
    const { contents } = renderEpisode({
      ...base,
      precision: 'unknown',
      confidence: null,
      ...spanFor({ precision: 'unknown' }),
    })
    expect(contents).toContain('occurred_at: ~')
    expect(contents).toContain('confidence: ~')
    expect(contents).toContain('# Undated')
  })

  it('carries entities and media through, quoting names that would break YAML', () => {
    const { contents } = renderEpisode({
      ...base,
      entities: [{ role: 'present', kind: 'person', canonicalName: 'A: the "one"' }],
      media: [{ path: 'media/IMG_0042.jpg', exifTakenAt: new Date('2014-07-12T18:20:00Z') }],
    })
    expect(contents).toContain('  - name: "A: the \\"one\\""')
    expect(contents).toContain('    role: present')
    expect(contents).toContain('  - path: "media/IMG_0042.jpg"')
  })

  it('lays annotation layers out oldest first, so the drift reads forward', () => {
    const { contents } = renderEpisode({
      ...base,
      annotations: [
        {
          namespace: 'self',
          author: 'user',
          writtenAt: new Date('2030-02-01T00:00:00Z'),
          body: 'Later reading.',
          supersedes: 'aaaaaaaa-0000-0000-0000-000000000000',
        },
        {
          namespace: 'self',
          author: 'user',
          writtenAt: new Date('2026-09-01T00:00:00Z'),
          body: 'First reading.',
          supersedes: null,
        },
      ],
    })
    expect(contents.indexOf('First reading.')).toBeLessThan(contents.indexOf('Later reading.'))
    expect(contents).toContain('## self — 2026-09-01 (user)')
    expect(contents).toContain('## self — 2030-02-01 (user, supersedes aaaaaaaa)')
  })
})

describe('renderIndex', () => {
  it('lists years newest first with the undated last', () => {
    const rows: ExportEpisode[] = [
      base,
      { ...base, id: 'c0000000-0000-0000-0000-000000000001', ...spanFor({ precision: 'year', year: 2021 }), precision: 'year' },
      { ...base, id: 'c0000000-0000-0000-0000-000000000002', ...spanFor({ precision: 'unknown' }), precision: 'unknown', confidence: null },
    ]
    const { path, contents } = renderIndex(rows, new Date('2026-08-18T04:00:00Z'))
    expect(path).toBe('README.md')
    expect(contents.indexOf('## 2021')).toBeLessThan(contents.indexOf('## 2014'))
    expect(contents.indexOf('## 2014')).toBeLessThan(contents.indexOf('## Undated'))
    expect(contents).toContain('3 episodes')
  })
})

describe('renderExport', () => {
  it('produces one file per episode plus the index, at unique paths', () => {
    const rows = [base, { ...base, id: 'c0000000-0000-0000-0000-000000000009' }]
    const files = renderExport(rows, new Date('2026-08-18T04:00:00Z'))
    expect(files).toHaveLength(3)
    expect(new Set(files.map((file) => file.path)).size).toBe(3)
  })
})
