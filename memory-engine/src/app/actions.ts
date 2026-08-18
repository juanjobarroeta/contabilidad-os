'use server'

import { revalidatePath } from 'next/cache'
import { createEpisode } from '@/lib/episodes'
import {
  buildEpisode,
  episodeInputSchema,
  fieldsFromForm,
  EpisodeInputError,
} from '@/lib/episode-input'

export interface ComposeState {
  error?: string
  savedAt?: number
}

/**
 * The only write in Phase 1. There is no counterpart that edits or removes an
 * episode, here or anywhere else — and if one were written, the database would
 * reject it.
 */
export async function composeEpisode(
  _previous: ComposeState,
  form: FormData,
): Promise<ComposeState> {
  const parsed = episodeInputSchema.safeParse(fieldsFromForm(form))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'That did not parse.' }
  }

  try {
    await createEpisode(buildEpisode(parsed.data), 'typed')
  } catch (error) {
    if (error instanceof EpisodeInputError) return { error: error.message }
    console.error(error)
    return { error: 'Could not save. The episode is still in the box — try again.' }
  }

  revalidatePath('/')
  return { savedAt: Date.now() }
}
