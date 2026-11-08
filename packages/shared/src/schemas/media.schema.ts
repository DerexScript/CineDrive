import { z } from 'zod';

export const mediaQuerySchema = z.object({
  type: z.enum(['movie', 'series']).optional(),
  genre: z.string().optional(),
  person: z.string().optional(),
  year: z.coerce.number().optional(),
  yearFrom: z.coerce.number().optional(),
  yearTo: z.coerce.number().optional(),
  minRating: z.coerce.number().optional(),
  search: z.string().trim().max(200).optional(),
  hideWithoutMetadata: z
    .preprocess(
      (value) => (value === 'true' ? true : value === 'false' ? false : value),
      z.boolean(),
    )
    .optional(),
  sortBy: z.enum(['title', 'year', 'voteAverage', 'createdAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type MediaQueryInput = z.infer<typeof mediaQuerySchema>;

export const randomMediaQuerySchema = z.object({
  type: z.enum(['movie', 'series']).optional(),
  minRating: z.coerce.number().min(0).max(10).optional(),
  compact: z.enum(['true', 'false']).optional(),
});

export type RandomMediaQueryInput = z.infer<typeof randomMediaQuerySchema>;

export const updateMediaMetadataSchema = z.object({
  title: z.string().min(1, 'Başlık boş olamaz.').optional(),
  year: z.coerce.number().nullable().optional(),
  overview: z.string().nullable().optional(),
  posterUrl: z.string().nullable().optional(),
  backdropUrl: z.string().nullable().optional(),
  genres: z.array(z.string()).optional(),
  voteAverage: z.coerce.number().nullable().optional(),
  trailerUrl: z.string().nullable().optional(),
});

export type UpdateMediaMetadataInput = z.infer<typeof updateMediaMetadataSchema>;

export const updateSeriesNoteSchema = z.object({
  note: z.string().max(10000),
});

export type UpdateSeriesNoteInput = z.infer<typeof updateSeriesNoteSchema>;

const openingSkipSecondsSchema = z.number().int().min(0).max(360000).nullable();
const completionThresholdSecondsSchema = z.number().int().min(1).max(360000).nullable();
const completionBeforeEndSecondsSchema = completionThresholdSecondsSchema.optional();

export const MAX_PLAYBACK_SKIP_BREAKPOINTS = 20;

export const playbackSkipBreakpointSchema = z.object({
  triggerSeconds: z.number().int().min(1).max(360000),
  targetSeconds: z.number().int().min(1).max(360000),
});

export type PlaybackSkipBreakpoint = z.infer<typeof playbackSkipBreakpointSchema>;

export const playbackSkipBreakpointsSchema = z
  .array(playbackSkipBreakpointSchema)
  .max(MAX_PLAYBACK_SKIP_BREAKPOINTS)
  .superRefine((breakpoints, context) => {
    const orderedBreakpoints = breakpoints
      .map((breakpoint, originalIndex) => ({ breakpoint, originalIndex }))
      .sort((left, right) => left.breakpoint.triggerSeconds - right.breakpoint.triggerSeconds);

    orderedBreakpoints.forEach(({ breakpoint, originalIndex }, index) => {
      if (breakpoint.targetSeconds <= breakpoint.triggerSeconds) {
        context.addIssue({
          code: 'custom',
          message: 'The target must be later than the trigger.',
          path: [originalIndex, 'targetSeconds'],
        });
      }

      const previous = orderedBreakpoints[index - 1]?.breakpoint;
      if (previous && breakpoint.triggerSeconds <= previous.targetSeconds) {
        context.addIssue({
          code: 'custom',
          message: 'Skip breakpoints must not overlap or chain together.',
          path: [originalIndex, 'triggerSeconds'],
        });
      }
    });
  });

const playbackSettingsFields = z.object({
  startAtSeconds: openingSkipSecondsSchema,
  completeAtSeconds: completionThresholdSecondsSchema,
  completeBeforeEndSeconds: completionBeforeEndSecondsSchema,
  skipBreakpoints: playbackSkipBreakpointsSchema.optional(),
});

const rejectConflictingCompletionRules = (
  settings: { completeAtSeconds: number | null; completeBeforeEndSeconds?: number | null },
  context: z.RefinementCtx,
) => {
  if (settings.completeAtSeconds !== null && settings.completeBeforeEndSeconds != null) {
    context.addIssue({
      code: 'custom',
      path: ['completeBeforeEndSeconds'],
      message: 'Choose either a fixed completion time or a time remaining before the end.',
    });
  }
};

export const updateSeriesPlaybackSettingsSchema = playbackSettingsFields.superRefine(
  rejectConflictingCompletionRules,
);

export type UpdateSeriesPlaybackSettingsInput = z.infer<typeof updateSeriesPlaybackSettingsSchema>;

export const updateEpisodePlaybackSettingsSchema = playbackSettingsFields
  .extend({ skipBreakpoints: playbackSkipBreakpointsSchema.nullable().optional() })
  .superRefine(rejectConflictingCompletionRules);

export type UpdateEpisodePlaybackSettingsInput = z.infer<
  typeof updateEpisodePlaybackSettingsSchema
>;

export const batchDeleteMediaSchema = z.object({
  ids: z.array(z.string()).min(1, 'En az 1 içerik seçilmelidir.'),
});

export type BatchDeleteMediaInput = z.infer<typeof batchDeleteMediaSchema>;
