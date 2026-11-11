export interface SeriesCompletionSettings {
  completeAtSeconds?: number | null;
  completeBeforeEndSeconds?: number | null;
}

/** Episode settings replace the series rule when either completion field is set. */
export const resolveSeriesCompletionSettings = (
  episode: SeriesCompletionSettings | null | undefined,
  series: SeriesCompletionSettings,
): SeriesCompletionSettings => {
  if (episode && (episode.completeAtSeconds != null || episode.completeBeforeEndSeconds != null)) {
    return episode;
  }

  return series;
};

/**
 * Resolves a configured series completion rule to an elapsed playback time.
 * Invalid, conflicting, or duration-incompatible settings return null so the
 * existing 98% series fallback remains in effect.
 */
export const resolveSeriesCompletionAtSeconds = (
  durationSeconds: number,
  settings: SeriesCompletionSettings,
): number | null => {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;

  const duration = Math.floor(durationSeconds);
  if (duration <= 0) return null;

  const fixedSeconds = settings.completeAtSeconds ?? null;
  const remainingSeconds = settings.completeBeforeEndSeconds ?? null;

  // New writes reject this state. Fail closed to the regular 98% fallback if
  // an inconsistent row is encountered in an existing or manually edited DB.
  if (fixedSeconds !== null && remainingSeconds !== null) return null;

  if (fixedSeconds !== null) {
    return Number.isInteger(fixedSeconds) && fixedSeconds > 0 && fixedSeconds <= duration
      ? fixedSeconds
      : null;
  }

  if (remainingSeconds !== null) {
    return Number.isInteger(remainingSeconds) && remainingSeconds > 0 && remainingSeconds < duration
      ? duration - remainingSeconds
      : null;
  }

  return null;
};
