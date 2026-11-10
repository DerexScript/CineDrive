import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { AudioTrackMetadata } from './media-probe.service.js';
import { MediaProbeService } from './media-probe.service.js';
import type { ResolvedDriveFile } from '../routes/media/shared.js';
import type { PreferredAudioPlaybackSelection } from './playback-plan.service.js';

export type PreferredAudioLanguage = 'pt-BR' | 'pt-PT' | 'en' | 'auto';

const mediaProbe = new MediaProbeService();
const pendingProbes = new Map<string, Promise<AudioTrackMetadata[]>>();

export const parseCachedAudioTracks = (value: string | null): AudioTrackMetadata[] | null => {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return parsed.every(
      (track) =>
        track &&
        typeof track === 'object' &&
        Number.isSafeInteger(track.streamIndex) &&
        typeof track.codec === 'string' &&
        (track.language === null || typeof track.language === 'string') &&
        (track.title === null || typeof track.title === 'string') &&
        (track.channelLayout === null || typeof track.channelLayout === 'string') &&
        typeof track.isDefault === 'boolean',
    )
      ? (parsed as AudioTrackMetadata[])
      : null;
  } catch {
    return null;
  }
};

export const buildLocalAudioTrackFingerprint = (
  size: number | bigint,
  modifiedTime: Date | number,
) => {
  const modifiedTimeMs = modifiedTime instanceof Date ? modifiedTime.getTime() : modifiedTime;
  return `local:${size}:${Math.trunc(modifiedTimeMs)}`;
};

export const buildGoogleDriveAudioTrackFingerprint = (
  size: bigint | null,
  modifiedTime: Date | null,
  md5Checksum: string | null,
) =>
  size === null
    ? null
    : ['gdrive', size.toString(), modifiedTime?.toISOString() || '', md5Checksum || ''].join(':');

const getFingerprint = async (file: ResolvedDriveFile, localFilePath?: string) => {
  if (localFilePath) {
    const stat = await fs.stat(localFilePath);
    return buildLocalAudioTrackFingerprint(stat.size, stat.mtimeMs);
  }

  const fingerprint = buildGoogleDriveAudioTrackFingerprint(
    file.size,
    file.modifiedTime,
    file.md5Checksum,
  );
  if (!fingerprint) throw new Error('AUDIO_TRACK_FILE_SIZE_UNAVAILABLE');
  return fingerprint;
};

/** Probe on demand, store by file version, and coalesce simultaneous requests. */
export const getAudioTrackCatalog = async (
  fastify: FastifyInstance,
  file: ResolvedDriveFile,
  userId: string,
  localFilePath?: string,
): Promise<AudioTrackMetadata[]> => {
  const fingerprint = await getFingerprint(file, localFilePath);
  const cached =
    file.audioTracksFingerprint === fingerprint
      ? parseCachedAudioTracks(file.audioTracksJson)
      : null;
  if (cached) return cached;

  const pendingKey = `${userId}:${file.id}:${fingerprint}`;
  const existing = pendingProbes.get(pendingKey);
  if (existing) return existing;

  const probe = (async () => {
    let tracks: AudioTrackMetadata[];
    if (localFilePath) {
      tracks = await mediaProbe.probeLocalAudioTracks(localFilePath);
    } else {
      if (!file.googleDriveFileId || file.size === null) {
        throw new Error('AUDIO_TRACK_SOURCE_UNAVAILABLE');
      }
      const { accessToken } = await fastify.driveAccessService.getAccess(userId, file);
      tracks = await mediaProbe.probeRemoteAudioTracks({
        name: file.name,
        size: file.size,
        readRange: (start, end) =>
          fastify.driveService.getMediaRangeBuffer(
            accessToken,
            file.googleDriveFileId!,
            start,
            end,
          ),
      });
    }

    await fastify.prisma.driveFile.update({
      where: { id: file.id },
      data: {
        audioTracksJson: JSON.stringify(tracks),
        audioTracksFingerprint: fingerprint,
      },
    });
    return tracks;
  })();

  pendingProbes.set(pendingKey, probe);
  try {
    return await probe;
  } finally {
    if (pendingProbes.get(pendingKey) === probe) pendingProbes.delete(pendingKey);
  }
};

export const getPreferredAudioLanguage = async (
  fastify: FastifyInstance,
  userId: string,
): Promise<PreferredAudioLanguage> => {
  const user = await fastify.prisma.user.findUnique({
    where: { id: userId },
    select: { preferredAudioLanguage: true },
  });
  const value = user?.preferredAudioLanguage;
  return value === 'pt-BR' || value === 'pt-PT' || value === 'en' || value === 'auto'
    ? value
    : 'pt-BR';
};

const normalizeLanguage = (language: string | null) =>
  language?.trim().replace(/_/g, '-').toLowerCase() || null;

export const choosePreferredAudioTrack = (
  tracks: AudioTrackMetadata[],
  preferredLanguage: PreferredAudioLanguage,
): AudioTrackMetadata | null => {
  if (tracks.length === 0) return null;
  if (preferredLanguage === 'auto') {
    return tracks.find((track) => track.isDefault) || tracks[0]!;
  }

  const wanted = normalizeLanguage(preferredLanguage)!;
  const exact = tracks.filter((track) => normalizeLanguage(track.language) === wanted);
  if (exact.length > 0) return exact.find((track) => track.isDefault) || exact[0]!;

  if (wanted.startsWith('pt-')) {
    const portuguese = tracks.filter((track) => {
      const language = normalizeLanguage(track.language);
      return language === 'pt' || language?.startsWith('pt-');
    });
    if (portuguese.length > 0) {
      return portuguese.find((track) => track.isDefault) || portuguese[0]!;
    }
  }

  const baseLanguage = wanted.split('-')[0];
  const sameLanguage = tracks.filter(
    (track) => normalizeLanguage(track.language)?.split('-')[0] === baseLanguage,
  );
  if (sameLanguage.length > 0) {
    return sameLanguage.find((track) => track.isDefault) || sameLanguage[0]!;
  }
  return tracks.find((track) => track.isDefault) || tracks[0]!;
};

export const buildPreferredAudioPlaybackSelection = (
  tracks: AudioTrackMetadata[] | null,
  preferredLanguage: PreferredAudioLanguage,
): PreferredAudioPlaybackSelection => {
  const preferredTrack = tracks
    ? choosePreferredAudioTrack(tracks, preferredLanguage)
    : null;
  const defaultTrack = tracks?.find((track) => track.isDefault) || tracks?.[0] || null;

  return {
    catalogKnown: tracks !== null,
    hasAudio: (tracks?.length || 0) > 0,
    codec: preferredTrack?.codec || null,
    isDefault:
      tracks !== null &&
      (tracks.length === 0 || preferredTrack?.streamIndex === defaultTrack?.streamIndex),
  };
};

export type AudioTrackRequest = { valid: true; streamIndex?: number } | { valid: false };

export const parseAudioTrackRequest = (value: unknown): AudioTrackRequest => {
  if (value === undefined) return { valid: true };
  if (typeof value !== 'string' || !/^\d{1,4}$/.test(value)) return { valid: false };
  const streamIndex = Number(value);
  return Number.isSafeInteger(streamIndex) ? { valid: true, streamIndex } : { valid: false };
};

export const resolveAudioTrackRequest = (
  tracks: AudioTrackMetadata[],
  requestedStreamIndex: number | undefined,
  preferredLanguage: PreferredAudioLanguage,
): AudioTrackMetadata | null => {
  if (requestedStreamIndex !== undefined) {
    const requested = tracks.find((track) => track.streamIndex === requestedStreamIndex);
    if (!requested) throw new Error('AUDIO_TRACK_NOT_FOUND');
    return requested;
  }
  return choosePreferredAudioTrack(tracks, preferredLanguage);
};
