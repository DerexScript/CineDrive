import type { FastifyPluginAsync } from 'fastify';
import {
  updateMediaMetadataSchema,
  updateSeriesPlaybackSettingsSchema,
  updateEpisodePlaybackSettingsSchema,
  playbackSkipBreakpointsSchema,
  batchDeleteMediaSchema,
  updateSeriesNoteSchema,
  type PlaybackSkipBreakpoint,
  type UpdateMediaMetadataInput,
  type UpdateSeriesNoteInput,
} from '@cinedrive/shared';
import { manageableMediaFilter, ownedMediaFilter } from '../utils/library-access.js';

const decodeSkipBreakpoints = (raw: string | null): PlaybackSkipBreakpoint[] | null => {
  if (raw === null) return null;
  try {
    const parsed = playbackSkipBreakpointsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
};

export const mediaEditRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', fastify.authenticate);

  const deleteMediaRows = async (userId: string, requestedIds: string[]) => {
    const ids = [...new Set(requestedIds)];
    const candidates = await fastify.prisma.mediaItem.findMany({
      where: { id: { in: ids }, ...manageableMediaFilter(userId) },
      select: { libraryId: true },
    });
    const locks: Array<{ release(): Promise<void> }> = [];
    try {
      for (const libraryId of [
        ...new Set(candidates.flatMap((item) => (item.libraryId ? [item.libraryId] : []))),
      ].sort()) {
        locks.push(await fastify.libraryOperationLockService.acquire(libraryId, 'delete'));
      }

      return await fastify.prisma.$transaction(async (tx) => {
        const mediaItems = await tx.mediaItem.findMany({
          where: { id: { in: ids }, ...manageableMediaFilter(userId) },
          select: {
            id: true,
            movie: { select: { driveFileId: true } },
            series: {
              select: {
                seasons: { select: { episodes: { select: { driveFileId: true } } } },
              },
            },
          },
        });
        const driveFileIds = [
          ...new Set(
            mediaItems.flatMap((item) => [
              ...(item.movie?.driveFileId ? [item.movie.driveFileId] : []),
              ...(item.series?.seasons.flatMap((season) =>
                season.episodes.map((episode) => episode.driveFileId),
              ) || []),
            ]),
          ),
        ];
        const ownedIds = mediaItems.map((item) => item.id);
        const deleteResult = await tx.mediaItem.deleteMany({
          where: { id: { in: ownedIds }, ...manageableMediaFilter(userId) },
        });

        // A DriveFile can be referenced by more than one derived media row in
        // legacy data. Only remove the physical index row after all references
        // are gone; the database cascade then cleans its subtitle/music data.
        if (driveFileIds.length) {
          await tx.driveFile.deleteMany({
            where: {
              id: { in: driveFileIds },
              movies: { none: {} },
              episodes: { none: {} },
              subtitles: { none: {} },
              musicTrack: { is: null },
            },
          });
        }
        return deleteResult.count;
      });
    } finally {
      await Promise.all(locks.map((lock) => lock.release()));
    }
  };

  // POST /api/media/batch-delete: Bulk remove media items from the database
  fastify.post<{ Body: { ids: string[] } }>('/batch-delete', async (request, reply) => {
    const parseResult = batchDeleteMediaSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: parseResult.error.issues[0]?.message || 'En az 1 içerik seçilmelidir.',
          requestId: request.id,
        },
      });
    }

    const { ids } = parseResult.data;

    /*
     * Every endpoint in this file addressed media by id alone. Being signed in
     * was the only requirement, so any account could delete or rewrite another
     * account's records by guessing or reading an id — and the ids are derived
     * from the title (`media_movie_inception`), so they are guessable.
     */
    let deletedCount: number;
    try {
      deletedCount = await deleteMediaRows(request.user!.id, ids);
    } catch (error) {
      if (error instanceof Error && error.message === 'LIBRARY_OPERATION_IN_PROGRESS') {
        return reply.status(409).send({
          error: {
            code: 'LIBRARY_OPERATION_IN_PROGRESS',
            message: 'Kütüphane taraması veya başka bir silme işlemi devam ediyor.',
            requestId: request.id,
          },
        });
      }
      throw error;
    }

    return reply.status(200).send({
      message: `${deletedCount} adet medya içeriği veritabanından silindi.`,
      deletedCount,
    });
  });

  // PATCH /api/media/:id: Update media item metadata
  fastify.patch<{ Params: { id: string }; Body: UpdateMediaMetadataInput }>(
    '/:id',
    async (request, reply) => {
      const { id } = request.params;

      const parseResult = updateMediaMetadataSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: parseResult.error.issues[0]?.message || 'Geçersiz veri.',
            requestId: request.id,
          },
        });
      }

      const data = parseResult.data;
      const updatePayload: Record<string, unknown> = {};

      if (data.title !== undefined) {
        updatePayload.title = data.title;
        updatePayload.normalizedTitle = data.title.toLowerCase();
      }
      if (data.year !== undefined) updatePayload.year = data.year;
      if (data.overview !== undefined) updatePayload.overview = data.overview;
      if (data.posterUrl !== undefined) updatePayload.posterUrl = data.posterUrl;
      if (data.backdropUrl !== undefined) updatePayload.backdropUrl = data.backdropUrl;
      if (data.voteAverage !== undefined) updatePayload.voteAverage = data.voteAverage;
      if (data.trailerUrl !== undefined) updatePayload.trailerUrl = data.trailerUrl;
      if (data.genres !== undefined) updatePayload.genres = JSON.stringify(data.genres);

      // Keep the authorization predicate in the write itself. A membership
      // revoke between a preliminary find and update must not leave a stale
      // caller able to mutate a now-inaccessible media row.
      const updated = await fastify.prisma.$transaction(async (tx) => {
        const result = await tx.mediaItem.updateMany({
          where: { id, ...manageableMediaFilter(request.user!.id) },
          data: updatePayload,
        });
        if (!result.count) return null;
        return tx.mediaItem.findUnique({ where: { id } });
      });

      if (!updated) {
        return reply.status(404).send({
          error: {
            code: 'MEDIA_NOT_FOUND',
            message: 'Medya içeriği bulunamadı.',
            requestId: request.id,
          },
        });
      }

      const { skipBreakpointsJson, ...updatedMediaItem } = updated;

      return reply.status(200).send({
        message: 'Medya bilgileri başarıyla güncellendi.',
        mediaItem: {
          ...updatedMediaItem,
          skipBreakpoints: decodeSkipBreakpoints(skipBreakpointsJson) ?? [],
        },
      });
    },
  );

  fastify.patch<{ Params: { id: string }; Body: UpdateSeriesNoteInput }>(
    '/:id/note',
    async (request, reply) => {
      const parsed = updateSeriesNoteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues[0]?.message || 'Invalid series note.',
            requestId: request.id,
          },
        });
      }

      const userId = request.user!.id;
      const note = parsed.data.note.trim() ? parsed.data.note : null;
      const result = await fastify.prisma.$transaction(async (tx) => {
        const series = await tx.mediaItem.findFirst({
          where: {
            id: request.params.id,
            type: 'series',
            ...ownedMediaFilter(userId),
          },
          select: { id: true },
        });
        if (!series) return null;

        if (note === null) {
          await tx.seriesNote.deleteMany({ where: { userId, mediaItemId: series.id } });
        } else {
          await tx.seriesNote.upsert({
            where: { userId_mediaItemId: { userId, mediaItemId: series.id } },
            create: { userId, mediaItemId: series.id, note },
            update: { note },
          });
        }

        return { note };
      });

      if (!result) {
        return reply.status(404).send({
          error: {
            code: 'MEDIA_NOT_FOUND',
            message: 'Series not found or not accessible.',
            requestId: request.id,
          },
        });
      }

      return reply.status(200).send({ personalNote: result.note });
    },
  );

  fastify.patch<{
    Params: { id: string };
    Body: {
      startAtSeconds: number | null;
      completeAtSeconds: number | null;
      skipBreakpoints?: PlaybackSkipBreakpoint[];
    };
  }>('/:id/playback-settings', async (request, reply) => {
    const parsed = updateSeriesPlaybackSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message || 'Invalid playback settings.',
          requestId: request.id,
        },
      });
    }

    const skipBreakpoints = parsed.data.skipBreakpoints
      ? [...parsed.data.skipBreakpoints].sort(
          (left, right) => left.triggerSeconds - right.triggerSeconds,
        )
      : undefined;
    const mediaItem = await fastify.prisma.$transaction(async (tx) => {
      const updated = await tx.mediaItem.updateMany({
        where: {
          id: request.params.id,
          type: 'series',
          ...manageableMediaFilter(request.user!.id),
        },
        data: {
          startAtSeconds: parsed.data.startAtSeconds,
          completeAtSeconds: parsed.data.completeAtSeconds,
          ...(skipBreakpoints !== undefined
            ? { skipBreakpointsJson: JSON.stringify(skipBreakpoints) }
            : {}),
        },
      });
      if (!updated.count) return null;
      return tx.mediaItem.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          startAtSeconds: true,
          completeAtSeconds: true,
          skipBreakpointsJson: true,
        },
      });
    });
    if (!mediaItem) {
      return reply.status(404).send({
        error: {
          code: 'MEDIA_NOT_FOUND',
          message: 'Series not found or not editable.',
          requestId: request.id,
        },
      });
    }

    return reply.status(200).send({
      mediaItem: {
        id: mediaItem.id,
        startAtSeconds: mediaItem.startAtSeconds,
        completeAtSeconds: mediaItem.completeAtSeconds,
        skipBreakpoints:
          skipBreakpoints ?? decodeSkipBreakpoints(mediaItem.skipBreakpointsJson) ?? [],
      },
    });
  });

  fastify.patch<{
    Params: { id: string; episodeId: string };
    Body: {
      startAtSeconds: number | null;
      completeAtSeconds: number | null;
      skipBreakpoints?: PlaybackSkipBreakpoint[] | null;
    };
  }>('/:id/episodes/:episodeId/playback-settings', async (request, reply) => {
    const parsed = updateEpisodePlaybackSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message || 'Invalid playback settings.',
          requestId: request.id,
        },
      });
    }

    const skipBreakpoints =
      parsed.data.skipBreakpoints === undefined || parsed.data.skipBreakpoints === null
        ? parsed.data.skipBreakpoints
        : [...parsed.data.skipBreakpoints].sort(
            (left, right) => left.triggerSeconds - right.triggerSeconds,
          );
    const episode = await fastify.prisma.$transaction(async (tx) => {
      const updated = await tx.episode.updateMany({
        where: {
          id: request.params.episodeId,
          mediaItemId: request.params.id,
          mediaItem: {
            is: {
              id: request.params.id,
              type: 'series',
              ...manageableMediaFilter(request.user!.id),
            },
          },
        },
        data: {
          startAtSeconds: parsed.data.startAtSeconds,
          completeAtSeconds: parsed.data.completeAtSeconds,
          ...(skipBreakpoints !== undefined
            ? {
                skipBreakpointsJson:
                  skipBreakpoints === null ? null : JSON.stringify(skipBreakpoints),
              }
            : {}),
        },
      });
      if (!updated.count) return null;
      return tx.episode.findUnique({
        where: { id: request.params.episodeId },
        select: {
          id: true,
          startAtSeconds: true,
          completeAtSeconds: true,
          skipBreakpointsJson: true,
        },
      });
    });
    if (!episode) {
      return reply.status(404).send({
        error: {
          code: 'MEDIA_NOT_FOUND',
          message: 'Episode not found or not editable.',
          requestId: request.id,
        },
      });
    }

    return reply.status(200).send({
      episode: {
        id: episode.id,
        startAtSeconds: episode.startAtSeconds,
        completeAtSeconds: episode.completeAtSeconds,
        skipBreakpoints:
          skipBreakpoints === undefined
            ? decodeSkipBreakpoints(episode.skipBreakpointsJson)
            : skipBreakpoints,
      },
    });
  });

  // DELETE /api/media/:id: Remove a media item from the database
  fastify.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { id } = request.params;

    const mediaItem = await fastify.prisma.mediaItem.findFirst({
      where: { id, ...manageableMediaFilter(request.user!.id) },
      select: { id: true },
    });

    if (!mediaItem) {
      return reply.status(404).send({
        error: {
          code: 'MEDIA_NOT_FOUND',
          message: 'Silinecek medya içeriği bulunamadı.',
          requestId: request.id,
        },
      });
    }

    try {
      await deleteMediaRows(request.user!.id, [mediaItem.id]);
    } catch (error) {
      if (error instanceof Error && error.message === 'LIBRARY_OPERATION_IN_PROGRESS') {
        return reply.status(409).send({
          error: {
            code: 'LIBRARY_OPERATION_IN_PROGRESS',
            message: 'Kütüphane taraması veya başka bir silme işlemi devam ediyor.',
            requestId: request.id,
          },
        });
      }
      throw error;
    }

    return reply.status(200).send({
      message: 'Medya içeriği veritabanından başarıyla silindi.',
      deletedMediaId: id,
    });
  });
};
