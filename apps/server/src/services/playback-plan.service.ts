export type PlaybackMode = 'direct' | 'audio' | 'hls' | 'full';

export interface PlaybackPlan {
  safari: PlaybackMode;
  chromium: PlaybackMode;
  reason: string;
  analyzed: boolean;
}

interface PlaybackSource {
  mediaContainer?: string | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  hasAudio?: boolean;
  mediaAnalyzedAt?: Date | null;
}

export interface PreferredAudioPlaybackSelection {
  catalogKnown: boolean;
  hasAudio: boolean;
  codec?: string | null;
  isDefault: boolean;
}

const SAFARI_DIRECT_CONTAINERS = new Set(['mp4', 'm4v', 'mov']);
// Chromium can direct-play Matroska files when their individual codecs are
// supported. Runtime playback errors still trigger the player's compatibility
// fallback, so the container alone should not force every MKV through FFmpeg.
const CHROMIUM_DIRECT_CONTAINERS = new Set(['mp4', 'm4v', 'mkv', 'webm']);
// HEVC support in Safari varies by the exact hvc1 sample structure and breaks
// for some otherwise valid files after fragmented-MP4 remuxing. The HLS
// compatibility path normalizes HEVC to H.264, so only H.264 is considered
// reliably direct-playable.
const SAFARI_VIDEO_CODECS = new Set(['h264']);
const CHROMIUM_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const SAFARI_AUDIO_CODECS = new Set(['aac', 'ac3', 'eac3', 'mp3']);
const CHROMIUM_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis']);

export const buildPlaybackPlan = (source: PlaybackSource): PlaybackPlan => {
  if (!source.mediaAnalyzedAt || !source.videoCodec) {
    return {
      safari: 'direct',
      chromium: 'direct',
      reason: 'technical_metadata_missing',
      analyzed: false,
    };
  }

  const container = source.mediaContainer?.toLowerCase() || '';
  const video = source.videoCodec.toLowerCase();
  const audio = source.audioCodec?.toLowerCase() || '';

  const safariVideoCompatible = SAFARI_VIDEO_CODECS.has(video);
  const safariAudioCompatible = source.hasAudio === false || SAFARI_AUDIO_CODECS.has(audio);
  const safariDirect =
    SAFARI_DIRECT_CONTAINERS.has(container) &&
    safariVideoCompatible &&
    safariAudioCompatible;
  const safari: PlaybackMode = safariDirect ? 'direct' : 'hls';

  const chromiumVideoCompatible = CHROMIUM_VIDEO_CODECS.has(video);
  const chromiumAudioCompatible = source.hasAudio === false || CHROMIUM_AUDIO_CODECS.has(audio);
  const chromiumDirect =
    CHROMIUM_DIRECT_CONTAINERS.has(container) &&
    chromiumVideoCompatible &&
    chromiumAudioCompatible;
  // For H.264 sources, the streaming compatibility route avoids HLS cache
  // generation; at offset 0 it copies video and converts the selected audio.
  const chromium: PlaybackMode = chromiumDirect
    ? 'direct'
    : (container === 'mp4' || container === 'm4v') && chromiumVideoCompatible
      ? 'audio'
      : video === 'h264'
        ? 'audio'
      : 'full';

  return {
    safari,
    chromium,
    reason: `${container || 'unknown'}:${video}:${audio || 'none'}`,
    analyzed: true,
  };
};

const compatibleModeForBrowser = (
  browser: 'safari' | 'chromium',
  plannedMode: PlaybackMode,
  source: PlaybackSource,
): PlaybackMode => {
  if (plannedMode !== 'direct') return plannedMode;
  if (browser === 'safari') return 'hls';

  const container = source.mediaContainer?.toLowerCase() || '';
  const video = source.videoCodec?.toLowerCase() || '';
  const chromiumVideoCompatible = CHROMIUM_VIDEO_CODECS.has(video);
  if ((container === 'mp4' || container === 'm4v') && chromiumVideoCompatible) {
    return 'audio';
  }
  if (video === 'h264') return 'hls';

  // With missing technical metadata, retain the former Chromium startup path.
  return source.mediaAnalyzedAt && source.videoCodec ? 'full' : 'audio';
};

/**
 * Extends the codec plan with the user's selected-language track. Direct
 * playback is safe only when the preferred track is the file's default (or
 * the file has no audio); unknown catalogs conservatively keep compatibility.
 */
export const buildPreferredAudioPlaybackPlan = (
  source: PlaybackSource,
  selection: PreferredAudioPlaybackSelection,
): PlaybackPlan => {
  const plannedSource: PlaybackSource = selection.catalogKnown
    ? {
        ...source,
        audioCodec: selection.hasAudio ? (selection.codec ?? source.audioCodec) : null,
        hasAudio: selection.hasAudio,
      }
    : source;
  const plan = buildPlaybackPlan(plannedSource);
  const technicalMetadataKnown = Boolean(source.mediaAnalyzedAt && source.videoCodec);
  const needsCompatibility =
    !selection.catalogKnown ||
    (selection.hasAudio && !selection.isDefault);

  if (!needsCompatibility) return plan;

  return {
    ...plan,
    safari: compatibleModeForBrowser('safari', plan.safari, plannedSource),
    chromium: compatibleModeForBrowser('chromium', plan.chromium, plannedSource),
    reason: !selection.catalogKnown
      ? 'audio_catalog_unknown'
      : !technicalMetadataKnown
        ? 'technical_metadata_missing'
        : `${plan.reason}:preferred_track_not_default`,
  };
};
