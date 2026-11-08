import type { FastifyPluginAsync } from 'fastify';
import { resolveSafeLocalFile } from '../../services/local-folder-validation.js';
import {
  choosePreferredAudioTrack,
  getAudioTrackCatalog,
  getPreferredAudioLanguage,
} from '../../services/audio-track-catalog.service.js';
import { resolveActiveDriveFile } from './shared.js';

/** Track metadata is probed on demand and cached against the current file version. */
export const mediaAudioTrackRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { driveFileId: string } }>(
    '/:driveFileId/audio-tracks',
    async (request, reply) => {
      const file = await resolveActiveDriveFile(
        fastify,
        request.params.driveFileId,
        request.user!.id,
      );
      if (!file) {
        return reply.status(404).send({
          error: {
            code: 'FILE_NOT_FOUND',
            message: 'The media file was not found or is not accessible.',
            requestId: request.id,
          },
        });
      }

      let localFilePath: string | undefined;
      if (file.storageType === 'local' && file.localFilePath) {
        try {
          localFilePath = await resolveSafeLocalFile(
            file.library.localFolderPath,
            file.localFilePath,
          );
        } catch {
          return reply.status(404).send({
            error: {
              code: 'LOCAL_FILE_NOT_FOUND',
              message: 'The local media file is unavailable.',
              requestId: request.id,
            },
          });
        }
      }

      try {
        const tracks = await getAudioTrackCatalog(fastify, file, request.user!.id, localFilePath);
        const preferredLanguage = await getPreferredAudioLanguage(fastify, request.user!.id);
        const recommended = choosePreferredAudioTrack(tracks, preferredLanguage);
        reply.header('Cache-Control', 'private, no-store');
        return reply.status(200).send({
          tracks,
          preferredLanguage,
          recommendedStreamIndex: recommended?.streamIndex ?? null,
        });
      } catch (error) {
        request.log.warn({ error, driveFileId: file.id }, 'Audio track discovery failed');
        return reply.status(503).send({
          error: {
            code: 'AUDIO_TRACK_DISCOVERY_FAILED',
            message: 'Audio tracks could not be read for this file.',
            requestId: request.id,
          },
        });
      }
    },
  );
};
