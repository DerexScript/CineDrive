import { useMemo } from 'react';
import type {
  EpisodeType,
  MediaItemType,
  PlaybackPlanType,
  PlaybackProgressType,
} from '../../../types/media';
import type { SubtitleItemType } from '../../../types/media';
import { resolveSeriesCompletionSettings, type PlaybackSkipBreakpoint } from '@cinedrive/shared';

export interface ActiveMedia {
  driveFileId: string | null;
  title: string;
  episodes: EpisodeType[];
  episodeIndex: number;
  previousEpisode: EpisodeType | null;
  nextEpisode: EpisodeType | null;
  activeEpisodeId?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  playbackPlan?: PlaybackPlanType;
  mediaDuration?: number;
  analyzedHeight?: number;
  startAtSeconds: number;
  completeAtSeconds: number | null;
  completeBeforeEndSeconds: number | null;
  skipBreakpoints: PlaybackSkipBreakpoint[];
  progress: PlaybackProgressType | null;
  subtitles: SubtitleItemType[];
}

const isPositiveFiniteDuration = (duration: number | null | undefined): duration is number =>
  typeof duration === 'number' && Number.isFinite(duration) && duration > 0;

const resolveMediaDuration = (
  analyzedDuration: number | null | undefined,
  storedDuration: number | null | undefined,
): number | undefined => {
  if (isPositiveFiniteDuration(analyzedDuration)) return analyzedDuration;
  return isPositiveFiniteDuration(storedDuration) ? storedDuration : undefined;
};

const formatEpisodeTitle = (mediaTitle: string, episode: EpisodeType) => {
  const paddedEpisode =
    episode.episodeNumber < 10 ? `0${episode.episodeNumber}` : `${episode.episodeNumber}`;
  return `${mediaTitle} - ${episode.seasonNumber}x${paddedEpisode} ${episode.title}`;
};

/**
 * Resolves "what exactly is playing" — the Drive file, its analysis results,
 * its subtitles and its neighbours — from the media item plus the requested
 * episode. Previously this was ~40 lines of `let` reassignment in the middle of
 * the component body, re-run on every render.
 */
export const useActiveMedia = (media: MediaItemType, episodeId?: string): ActiveMedia =>
  useMemo(() => {
    const base: ActiveMedia = {
      driveFileId: null,
      title: media.title,
      episodes: [],
      episodeIndex: -1,
      previousEpisode: null,
      nextEpisode: null,
      activeEpisodeId: episodeId,
      startAtSeconds: 0,
      completeAtSeconds: null,
      completeBeforeEndSeconds: null,
      skipBreakpoints: [],
      progress: media.progress || null,
      subtitles: media.subtitles || [],
    };

    if (media.type === 'movie' && media.movie) {
      return {
        ...base,
        driveFileId: media.movie.driveFileId,
        playbackPlan: media.movie.playbackPlan,
        mediaDuration: resolveMediaDuration(
          media.movie.technicalMetadata?.mediaDuration,
          media.duration,
        ),
        analyzedHeight: media.movie.technicalMetadata?.mediaHeight,
      };
    }

    if (media.type !== 'series' || !media.series) return base;

    const episodes = media.series.seasons.flatMap((season) => season.episodes);
    // A generic "play/resume series" route has no episode in the URL. In that
    // case, open the episode represented by the aggregate latest progress row.
    // An explicitly selected episode always takes precedence.
    const requestedEpisodeId = episodeId ?? media.progress?.episodeId ?? undefined;
    const requestedIndex = requestedEpisodeId
      ? episodes.findIndex((e) => e.id === requestedEpisodeId)
      : 0;
    const episodeIndex = requestedIndex < 0 ? 0 : requestedIndex;
    const episode = episodes[episodeIndex];

    if (!episode) return { ...base, episodes };

    const completionSettings = resolveSeriesCompletionSettings(episode, media);

    return {
      ...base,
      episodes,
      episodeIndex,
      previousEpisode: episodeIndex > 0 ? episodes[episodeIndex - 1]! : null,
      nextEpisode: episodeIndex < episodes.length - 1 ? episodes[episodeIndex + 1]! : null,
      activeEpisodeId: episode.id,
      startAtSeconds: episode.startAtSeconds ?? media.startAtSeconds ?? 0,
      completeAtSeconds: completionSettings.completeAtSeconds ?? null,
      completeBeforeEndSeconds: completionSettings.completeBeforeEndSeconds ?? null,
      skipBreakpoints: episode.skipBreakpoints ?? media.skipBreakpoints ?? [],
      driveFileId: episode.driveFileId,
      title: formatEpisodeTitle(media.title, episode),
      seasonNumber: episode.seasonNumber,
      episodeNumber: episode.episodeNumber,
      playbackPlan: episode.playbackPlan,
      mediaDuration: resolveMediaDuration(
        episode.technicalMetadata?.mediaDuration,
        episode.duration,
      ),
      analyzedHeight: episode.technicalMetadata?.mediaHeight,
      progress:
        episode.playbackProgresses?.[0] ||
        (media.progress?.episodeId === episode.id || (!episodeId && !media.progress?.episodeId)
          ? media.progress || null
          : null),
      subtitles: episode.subtitles || media.subtitles || [],
    };
  }, [episodeId, media]);
