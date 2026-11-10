import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_SERIES_COMPLETION_THRESHOLD_PERCENT,
  resolveSeriesCompletionAtSeconds,
} from '@cinedrive/shared';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2, Clock } from 'lucide-react';
import { PlayerControls } from './PlayerControls';
import { ResumeOverlay } from './ResumeOverlay';
import { NextEpisodeOverlay } from './NextEpisodeOverlay';
import { PlayerError } from './PlayerError';
import { usePlayerStore } from '../stores/usePlayerStore';
import { useUiStore } from '../../../stores/useUiStore';
import { usePlaybackProgress } from '../hooks/usePlaybackProgress';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { usePlayerControls } from '../hooks/usePlayerControls';
import { useHlsPlayback } from '../hooks/useHlsPlayback';
import { useActiveMedia } from '../hooks/useActiveMedia';
import { usePlaybackSource } from '../hooks/usePlaybackSource';
import { useAudioTrackCatalogQuery } from '../../../hooks/useApi';
import { useSubtitleTracks } from '../hooks/useSubtitleTracks';
import { usePlayerTelemetry } from '../hooks/usePlayerTelemetry';
import { useResettableState } from '../../../hooks/useResettableState';
import {
  getBrowserFamily,
  getBufferedAheadSeconds,
  isSafariBrowser,
  togglePlayerFullscreen,
} from '../utils/playerBrowser';
import {
  alignSubtitleCueToPlaybackTimeline,
  getNativeSubtitleSource,
} from '../utils/subtitleTracks';
import { findActiveSubtitleCue } from '../utils/subtitleCues';
import { t } from '../../../i18n';
import type { PlayerErrorState, SubtitleTrackType } from '../types/player';
import type { MediaItemType, PlaybackMode } from '../../../types/media';

interface MediaPlayerProps {
  media: MediaItemType;
  episodeId?: string;
  fullscreenContainerRef?: React.RefObject<HTMLDivElement | null>;
}

const STALL_RECOVERY_DELAY_MS = 12_000;
const MAX_STALL_RECOVERY_ATTEMPTS = 2;
const HLS_SEEK_DEBOUNCE_MS = 400;
/** After any source change, ignore end-of-media heuristics for this long. */
const NEXT_EPISODE_SUPPRESSION_MS = 20_000;
const AUDIO_COMPATIBILITY_PROBE_MS = 6000;
const AUDIO_COMPATIBILITY_REWIND_SECONDS = 5;
const STABLE_PLAYBACK_RESET_MS = 30_000;

// Chromium can advance video while silently skipping these audio codecs in direct playback.
const requiresChromiumAudioCompatibility = (codec: string) => {
  const normalizedCodec = codec.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    normalizedCodec === 'ac3' ||
    normalizedCodec === 'eac3' ||
    normalizedCodec.startsWith('dts') ||
    normalizedCodec === 'dca' ||
    normalizedCodec.startsWith('truehd')
  );
};

export const MediaPlayer: React.FC<MediaPlayerProps> = ({
  media,
  episodeId,
  fullscreenContainerRef,
}) => {
  const navigate = useNavigate();
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const isSafari = isSafariBrowser();

  const {
    volume,
    isMuted,
    playbackSpeed,
    autoPlayNext,
    subtitleDelay,
    subtitleFontSize,
    subtitleBgColor,
    setVolume,
    setIsMuted,
    setPlaybackSpeed,
    setSubtitleDelay,
  } = usePlayerStore();
  const cinemaMode = useUiStore((state) => state.cinemaMode);

  const active = useActiveMedia(media, episodeId);
  const compatibilityFallback: PlaybackMode = isSafari ? 'hls' : 'audio';
  const playbackPlanNeedsAudioCatalog =
    Boolean(active.driveFileId) &&
    (!active.playbackPlan || active.playbackPlan.reason === 'audio_catalog_unknown');
  const audioTrackCatalogQuery = useAudioTrackCatalogQuery(
    active.driveFileId,
    playbackPlanNeedsAudioCatalog,
  );
  const { data: audioTrackCatalog } = audioTrackCatalogQuery;
  const canUseCatalogPlaybackPlan =
    playbackPlanNeedsAudioCatalog &&
    Boolean(audioTrackCatalog?.playbackPlan) &&
    audioTrackCatalogQuery.isFetchedAfterMount &&
    !audioTrackCatalogQuery.isFetching &&
    !audioTrackCatalogQuery.isError;
  const effectivePlaybackPlan = canUseCatalogPlaybackPlan
    ? audioTrackCatalog?.playbackPlan
    : active.playbackPlan;
  const recommendedMode: PlaybackMode = isSafari
    ? (effectivePlaybackPlan?.safari ?? compatibilityFallback)
    : (effectivePlaybackPlan?.chromium ?? compatibilityFallback);
  const compatibilityMode: PlaybackMode =
    recommendedMode === 'direct' ? compatibilityFallback : recommendedMode;
  const isResolvingPlaybackPlan =
    playbackPlanNeedsAudioCatalog &&
    !audioTrackCatalogQuery.isError &&
    (!audioTrackCatalogQuery.isFetchedAfterMount || audioTrackCatalogQuery.isFetching);

  const source = usePlaybackSource({
    driveFileId: active.driveFileId,
    recommendedMode,
    sourceHeight: active.analyzedHeight,
  });
  const { dispatch: dispatchSource, timelineOffset, useTranscode } = source;
  const audioTracks = audioTrackCatalog?.tracks || [];
  const audioTrackCatalogStatus =
    !active.driveFileId
      ? 'ready'
      : isResolvingPlaybackPlan
        ? 'loading'
        : audioTrackCatalog
          ? 'ready'
          : audioTrackCatalogQuery.isError && !audioTrackCatalogQuery.isFetching
            ? 'error'
            : 'loading';
  const activeAudioTrack = audioTracks.find(
    (track) =>
      track.streamIndex ===
      (source.selectedAudioTrackIndex ?? audioTrackCatalog?.recommendedStreamIndex),
  );
  const shouldDelayPlaybackForPlan =
    isResolvingPlaybackPlan ||
    (canUseCatalogPlaybackPlan && source.playbackMode !== recommendedMode);

  // --- Timers and cross-render bookkeeping -------------------------------
  const audioCompatibilityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallRecoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stablePlaybackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSeekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallRecoveryAttemptsRef = useRef(0);
  const recoveryPositionRef = useRef<number | null>(null);
  const resumeAfterSourceChangeRef = useRef<PlaybackMode | null>(null);
  const automaticFallbackModesTriedRef = useRef<Set<PlaybackMode>>(new Set([recommendedMode]));
  const automaticFallbackPendingModeRef = useRef<PlaybackMode | null>(null);
  const latestPlaybackStateRef = useRef({ position: 0, isPlaying: false });
  const resumePromptHandledRef = useRef(false);
  const initialPositionHandledKeyRef = useRef<string | null>(null);
  const completionThresholdTriggeredRef = useRef(false);
  const skipBreakpointEpisodeKeyRef = useRef<string | null>(null);
  const previousSkipBreakpointPositionRef = useRef<number | null>(null);
  const pendingSkipBreakpointTargetRef = useRef<number | null>(null);
  const suppressNextEpisodeUntilRef = useRef(0);
  const sourceStartedAtRef = useRef(0);
  const firstFrameReportedRef = useRef(false);
  const stallStartedAtRef = useRef<number | null>(null);
  const seekStartedAtRef = useRef<number | null>(null);
  const lastTimeUpdateRef = useRef(0);
  const nextEpisodeDismissedRef = useRef(false);
  const originalCueTimesRef = useRef(
    new WeakMap<TextTrackCue, { startTime: number; endTime: number }>(),
  );

  // --- Local playback state ----------------------------------------------
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(active.mediaDuration || 0);
  const [bufferedTime, setBufferedTime] = useState(0);
  const initialPositionKey = JSON.stringify([
    media.id,
    active.activeEpisodeId ?? episodeId ?? null,
    active.driveFileId,
  ]);
  const sourceResetKey = `${active.driveFileId || 'missing'}:${recommendedMode}:${source.automaticQuality}`;
  const setSkipBreakpointPosition = (
    positionSeconds: number,
    pendingTargetSeconds: number | null = null,
  ) => {
    skipBreakpointEpisodeKeyRef.current = initialPositionKey;
    previousSkipBreakpointPositionRef.current = positionSeconds;
    pendingSkipBreakpointTargetRef.current = pendingTargetSeconds;
  };
  const missingDriveError: PlayerErrorState | null = active.driveFileId
    ? null
    : {
        code: 'STREAM_FAILED',
        message: t.player.noDriveFile,
        isRetryable: false,
      };
  const [showResumeModal, setShowResumeModal] = useResettableState(false, sourceResetKey);
  const [showNextEpisodeModal, setShowNextEpisodeModal] = useResettableState(false, episodeId);
  const [errorState, setErrorState] = useResettableState<PlayerErrorState | null>(
    missingDriveError,
    sourceResetKey,
  );
  const [isNativeVideoFullscreen, setIsNativeVideoFullscreen] = useState(false);
  const [connectionMessage, setConnectionMessage] = useResettableState<string | null>(
    null,
    sourceResetKey,
  );
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const [delayToast, setDelayToast] = useState<string | null>(null);

  const { areControlsVisible, resetHideTimer } = usePlayerControls(isPlaying);

  const handleSubtitleLoadError = useCallback(
    (message: string) => setConnectionMessage(message),
    [setConnectionMessage],
  );
  const subtitles = useSubtitleTracks({
    ownerId: active.activeEpisodeId || media.id,
    serverSubtitles: active.subtitles,
    onLoadError: handleSubtitleLoadError,
  });
  const {
    activeSubtitleId,
    availableSubtitles,
    resolvedSubtitles,
    trackLoadVersion,
    markTrackLoaded,
    selectSubtitle,
  } = subtitles;

  const reportTelemetry = usePlayerTelemetry({
    mediaId: media.id,
    driveFileId: active.driveFileId,
    isSafari,
    playbackMode: shouldDelayPlaybackForPlan ? 'direct' : source.playbackMode,
    sessionId: source.sessionId,
    startOffset: source.startOffset,
  });

  const { saveProgress } = usePlaybackProgress({
    mediaItemId: media.id,
    episodeId: active.activeEpisodeId,
    initialServerRevision: active.progress?.serverRevision ?? 0,
    isPlaying,
    currentTime,
    duration,
  });

  // iPhone Safari shows only the native video layer in fullscreen, so every
  // subtitle source stays a real text track.
  const activeOverlaySubtitle = resolvedSubtitles.find(
    (subtitle) =>
      subtitle.cues?.length &&
      (subtitle.id === activeSubtitleId || (subtitle.isDefault && !activeSubtitleId)),
  );
  const activeOverlayCue = activeOverlaySubtitle?.cues
    ? findActiveSubtitleCue(activeOverlaySubtitle.cues, currentTime, subtitleDelay)
    : undefined;

  const suppressNextEpisode = useCallback(() => {
    suppressNextEpisodeUntilRef.current = Date.now() + NEXT_EPISODE_SUPPRESSION_MS;
  }, []);

  const clearTimer = (ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
    if (!ref.current) return;
    clearTimeout(ref.current);
    ref.current = null;
  };

  const switchToAutomaticFallback = useCallback(
    (
      failedMode: PlaybackMode,
      localPositionSeconds?: number,
      playbackIntent?: boolean,
    ) => {
      if (
        automaticFallbackPendingModeRef.current &&
        failedMode !== automaticFallbackPendingModeRef.current
      ) {
        return true;
      }
      automaticFallbackPendingModeRef.current = null;

      const fallbackCandidates: PlaybackMode[] =
        failedMode === 'direct'
          ? [compatibilityMode, isSafari ? 'full' : 'hls', 'audio', 'full']
          : failedMode === 'hls'
            ? ['audio', 'full']
            : failedMode === 'audio'
              ? ['hls', 'full']
              : ['hls', 'audio'];
      // A failed mode is never selected again for this source, preventing a
      // compatibility loop while still allowing the remaining transports.
      const triedModes = automaticFallbackModesTriedRef.current;
      triedModes.add(failedMode);
      const fallbackMode = fallbackCandidates.find(
        (candidate) => candidate !== failedMode && !triedModes.has(candidate),
      );
      if (!fallbackMode) return false;

      triedModes.add(fallbackMode);
      automaticFallbackPendingModeRef.current = fallbackMode;
      const video = videoRef.current;
      const candidatePosition =
        localPositionSeconds !== undefined
          ? localPositionSeconds + timelineOffset
          : video && Number.isFinite(video.currentTime)
            ? video.currentTime + timelineOffset
            : latestPlaybackStateRef.current.position;
      const playbackPosition = Number.isFinite(candidatePosition)
        ? Math.max(0, candidatePosition)
        : Math.max(0, latestPlaybackStateRef.current.position);
      const shouldResume =
        playbackIntent ??
        (latestPlaybackStateRef.current.isPlaying || Boolean(video && !video.paused));

      suppressNextEpisode();
      latestPlaybackStateRef.current.position = playbackPosition;
      latestPlaybackStateRef.current.isPlaying = shouldResume;
      recoveryPositionRef.current = null;
      resumeAfterSourceChangeRef.current = shouldResume ? fallbackMode : null;
      setErrorState(null);
      setIsBuffering(true);
      setConnectionMessage(t.player.buffering);
      dispatchSource({
        type: 'setMode',
        playbackMode: fallbackMode,
        offsetSeconds: Math.floor(playbackPosition),
      });
      return true;
    },
    [
      compatibilityMode,
      dispatchSource,
      isSafari,
      setConnectionMessage,
      setErrorState,
      suppressNextEpisode,
      timelineOffset,
    ],
  );
  const switchToAutomaticFallbackRef = useRef(switchToAutomaticFallback);
  useLayoutEffect(() => {
    switchToAutomaticFallbackRef.current = switchToAutomaticFallback;
  }, [switchToAutomaticFallback]);

  // --- Source lifecycle ---------------------------------------------------
  useEffect(() => {
    clearTimer(pendingSeekTimerRef);
    automaticFallbackModesTriedRef.current = new Set([recommendedMode]);
    automaticFallbackPendingModeRef.current = null;
    latestPlaybackStateRef.current = { position: 0, isPlaying: false };
    dispatchSource({
      type: 'reset',
      driveFileId: active.driveFileId,
      playbackMode: recommendedMode,
      adaptiveQuality: source.automaticQuality,
    });
    resumePromptHandledRef.current = false;
    stallRecoveryAttemptsRef.current = 0;
    recoveryPositionRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart only when the file or its recommended strategy changes
  }, [active.driveFileId, recommendedMode, source.automaticQuality]);

  useEffect(() => {
    nextEpisodeDismissedRef.current = false;
    completionThresholdTriggeredRef.current = false;
  }, [episodeId]);

  useLayoutEffect(() => {
    suppressNextEpisode();
    sourceStartedAtRef.current = performance.now();
    firstFrameReportedRef.current = false;
    stallStartedAtRef.current = null;
  }, [source.sourceUrl, suppressNextEpisode]);

  // Clean up every pending timer on unmount.
  useEffect(
    () => () => {
      clearTimer(audioCompatibilityTimerRef);
      clearTimer(stallRecoveryTimerRef);
      clearTimer(stablePlaybackTimerRef);
      clearTimer(pendingSeekTimerRef);
    },
    [],
  );

  const handleHlsUnsupported = useCallback(() => {
    if (switchToAutomaticFallbackRef.current('hls')) return;
    setErrorState({
      code: 'STREAM_FAILED',
      message: t.player.hlsUnsupported,
      isRetryable: true,
    });
  }, [setErrorState]);
  const handleFatalHlsError = useCallback(
    (positionSeconds: number, playbackIntent: boolean, fallbackAllowed: boolean) => {
      if (
        fallbackAllowed &&
        switchToAutomaticFallbackRef.current('hls', positionSeconds, playbackIntent)
      ) {
        return;
      }
      resumeAfterSourceChangeRef.current = null;
      setIsBuffering(false);
      setConnectionMessage(null);
      setErrorState({
        code: 'STREAM_FAILED',
        message: t.player.hlsRecoveryFailed,
        isRetryable: true,
      });
    },
    [setConnectionMessage, setErrorState],
  );
  const handleHlsRecovering = useCallback(
    (attempt: number, max: number) => {
      resumeAfterSourceChangeRef.current = null;
      setIsBuffering(true);
      setConnectionMessage(t.player.reconnectingAttempt(attempt, max));
    },
    [setConnectionMessage],
  );
  const handleHlsRecovered = useCallback(() => {
    setIsBuffering(false);
    setConnectionMessage(null);
  }, [setConnectionMessage]);
  const {
    retry: retryHls,
    setPlaybackIntent: setHlsPlaybackIntent,
    handleLoadedMetadata: handleHlsLoadedMetadata,
    handleSourceError: handleHlsSourceError,
    getRecoveryPosition: getHlsRecoveryPosition,
  } = useHlsPlayback({
    videoRef,
    sourceUrl: shouldDelayPlaybackForPlan ? '' : source.sourceUrl,
    active: source.playbackMode === 'hls' && !shouldDelayPlaybackForPlan,
    native: isSafari,
    onUnsupported: handleHlsUnsupported,
    onFatalError: handleFatalHlsError,
    onRecovering: handleHlsRecovering,
    onRecovered: handleHlsRecovered,
  });

  // Autoplay again once a replacement source is ready, if we were playing.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || resumeAfterSourceChangeRef.current !== source.playbackMode) return;

    let cancelled = false;
    const resume = () => {
      if (cancelled || resumeAfterSourceChangeRef.current !== source.playbackMode) return;
      video.play().catch(() => {
        // Keep listening for the next readiness event.
      });
    };

    video.addEventListener('canplay', resume);
    const resumeTimers = [0, 250, 1_000, 2_500].map((delay) => setTimeout(resume, delay));
    return () => {
      cancelled = true;
      resumeTimers.forEach(clearTimeout);
      video.removeEventListener('canplay', resume);
    };
  }, [source.playbackMode, source.sourceUrl]);

  // --- Subtitles ----------------------------------------------------------
  useEffect(() => {
    if (!videoRef.current) return;
    Array.from(videoRef.current.textTracks).forEach((track, index) => {
      const subtitle = resolvedSubtitles[index];
      if (
        subtitle &&
        (subtitle.id === activeSubtitleId || (subtitle.isDefault && !activeSubtitleId))
      ) {
        // Cue-backed subtitles use the styled HTML overlay inline, but iPhone
        // native fullscreen can only display a showing native text track.
        track.mode = subtitle.cues?.length && !isNativeVideoFullscreen ? 'hidden' : 'showing';
      } else {
        track.mode = 'disabled';
      }
    });
  }, [activeSubtitleId, isNativeVideoFullscreen, resolvedSubtitles, trackLoadVersion]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleNativeFullscreenStart = () => {
      // Change the mode synchronously while Safari is entering its native
      // player; waiting for a React render can be too late on some iPhones.
      Array.from(video.textTracks).forEach((track, index) => {
        const subtitle = resolvedSubtitles[index];
        track.mode =
          subtitle &&
          (subtitle.id === activeSubtitleId || (subtitle.isDefault && !activeSubtitleId))
            ? 'showing'
            : 'disabled';
      });
      setIsNativeVideoFullscreen(true);
    };
    const handleNativeFullscreenEnd = () => setIsNativeVideoFullscreen(false);

    video.addEventListener('webkitbeginfullscreen', handleNativeFullscreenStart);
    video.addEventListener('webkitendfullscreen', handleNativeFullscreenEnd);
    return () => {
      video.removeEventListener('webkitbeginfullscreen', handleNativeFullscreenStart);
      video.removeEventListener('webkitendfullscreen', handleNativeFullscreenEnd);
    };
  }, [activeSubtitleId, resolvedSubtitles]);

  // Native Safari HLS restarts its media timeline at zero after an absolute
  // seek. Keep native cues on that local timeline, preserving the live delay.
  useEffect(() => {
    if (!videoRef.current) return;

    Array.from(videoRef.current.textTracks).forEach((track) => {
      if (!track.cues) return;
      Array.from(track.cues).forEach((cue) => {
        let originalTimes = originalCueTimesRef.current.get(cue);
        if (!originalTimes) {
          originalTimes = { startTime: cue.startTime, endTime: cue.endTime };
          originalCueTimesRef.current.set(cue, originalTimes);
        }

        const aligned = alignSubtitleCueToPlaybackTimeline(
          originalTimes.startTime,
          originalTimes.endTime,
          timelineOffset,
          subtitleDelay,
        );
        cue.startTime = aligned.startTime;
        cue.endTime = aligned.endTime;
      });
    });
  }, [subtitleDelay, timelineOffset, trackLoadVersion]);

  // Z & X adjust the subtitle delay live.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }

      const key = e.key.toLowerCase();
      if (key !== 'z' && key !== 'x') return;

      const next = parseFloat((subtitleDelay + (key === 'z' ? -0.1 : 0.1)).toFixed(1));
      setSubtitleDelay(next);
      setDelayToast(t.player.subtitleDelay(next > 0 ? `+${next}s` : `${next}s`));
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setSubtitleDelay, subtitleDelay]);

  useEffect(() => {
    if (!delayToast) return;
    const timer = setTimeout(() => setDelayToast(null), 2500);
    return () => clearTimeout(timer);
  }, [delayToast]);

  const handleSelectOpenSubtitle = useCallback(
    async (fileId: number, label: string, languageCode: string) => {
      const res = await fetch('/api/media/subtitles/opensubtitles/download', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId,
          mediaId: media.id,
          episodeId: active.activeEpisodeId,
          label,
          languageCode,
        }),
      });

      if (!res.ok) throw new Error('Download failed');
      const result = (await res.json()) as {
        subtitleTrack: SubtitleTrackType;
        vttContent: string;
      };
      subtitles.addDownloadedSubtitle(result.subtitleTrack, result.vttContent);
    },
    [active.activeEpisodeId, media.id, subtitles],
  );

  // --- Seeking ------------------------------------------------------------
  const seekToAbsoluteTime = useCallback(
    (requestedTime: number, shouldPlay = true, forceSourceReload = false) => {
      const video = videoRef.current;
      if (!video || !Number.isFinite(requestedTime)) return;

      const targetTime = Math.max(
        0,
        duration > 0 ? Math.min(duration, requestedTime) : requestedTime,
      );
    latestPlaybackStateRef.current.position = targetTime;
      seekStartedAtRef.current = performance.now();
      saveProgress(false, targetTime);

      if (source.playbackMode === 'direct') {
        clearTimer(pendingSeekTimerRef);
        video.currentTime = targetTime;
        if (shouldPlay) video.play().catch(() => {});
        return;
      }

      // A transcoded stream can only seek inside the window it has produced;
      // anything else needs a new job starting at the target position.
      const localTarget = targetTime - source.startOffset;
      let isInCurrentWindow = false;
      if (source.playbackMode === 'hls') {
        for (let index = 0; index < video.seekable.length; index++) {
          if (
            localTarget >= video.seekable.start(index) &&
            localTarget <= video.seekable.end(index)
          ) {
            isInCurrentWindow = true;
            break;
          }
        }
      }

      if (isInCurrentWindow && !forceSourceReload) {
        clearTimer(pendingSeekTimerRef);
        video.currentTime = localTarget;
        if (shouldPlay) video.play().catch(() => {});
        return;
      }

      suppressNextEpisode();
      // Resume the mode that is actually being reloaded. Using a fixed HLS
      // marker leaves audio/full compatibility streams paused at local 0.
      resumeAfterSourceChangeRef.current = shouldPlay ? source.playbackMode : null;
      setCurrentTime(targetTime);
      setBufferedTime(targetTime);
      setIsBuffering(true);
      setConnectionMessage(
        t.player.preparingFrom(
          `${Math.floor(targetTime / 60)}:${String(Math.floor(targetTime % 60)).padStart(2, '0')}`,
        ),
      );

      clearTimer(pendingSeekTimerRef);
      pendingSeekTimerRef.current = setTimeout(() => {
        pendingSeekTimerRef.current = null;
        dispatchSource({ type: 'seekTo', offsetSeconds: Math.floor(targetTime) });
      }, HLS_SEEK_DEBOUNCE_MS);
    },
    [
      dispatchSource,
      duration,
      saveProgress,
      setConnectionMessage,
      source.playbackMode,
      source.startOffset,
      suppressNextEpisode,
    ],
  );

  // --- Media element event handlers ---------------------------------------
  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video) return;
    if (automaticFallbackPendingModeRef.current === source.playbackMode) {
      automaticFallbackPendingModeRef.current = null;
    }

    const localPlaybackTime =
      source.playbackMode === 'hls'
        ? (getHlsRecoveryPosition() ?? video.currentTime)
        : video.currentTime;
    if (skipBreakpointEpisodeKeyRef.current !== initialPositionKey) {
      setSkipBreakpointPosition(localPlaybackTime + timelineOffset);
    }

    setIsBuffering(false);
    const reportedDuration = video.duration;
    setDuration(
      active.mediaDuration && active.mediaDuration > 0
        ? active.mediaDuration
        : Number.isFinite(reportedDuration) && reportedDuration > 0
          ? reportedDuration
          : 0,
    );

    // A recovery owns position restoration and playback intent. In particular,
    // do not let the normal initial autoplay undo a pause during reconnection.
    if (source.playbackMode === 'hls' && handleHlsLoadedMetadata()) return;

    if (video.error) {
      if (switchToAutomaticFallback(source.playbackMode)) return;
      resumeAfterSourceChangeRef.current = null;
      setErrorState({
        code: 'STREAM_FAILED',
        message: t.player.streamStartFailed,
        isRetryable: true,
      });
      return;
    }

    if (recoveryPositionRef.current !== null) {
      const recoveryPosition = recoveryPositionRef.current;
      recoveryPositionRef.current = null;
      setSkipBreakpointPosition(recoveryPosition, recoveryPosition);
      video.currentTime = useTranscode
        ? Math.max(0, recoveryPosition - source.startOffset)
        : recoveryPosition;
      video.play().catch(() => {});
      return;
    }

    // A seek to a nonzero compatibility-stream offset reloads the media source,
    // which emits loadedmetadata again. Only make the initial resume/skip choice
    // once for this episode, so that reload cannot seek back to the same point.
    if (initialPositionHandledKeyRef.current === initialPositionKey) return;
    initialPositionHandledKeyRef.current = initialPositionKey;

    const savedPosition = active.progress?.completed ? 0 : active.progress?.positionSeconds || 0;
    const configuredStart = active.startAtSeconds;
    const shouldOfferResume =
      !resumePromptHandledRef.current &&
      !active.progress?.completed &&
      savedPosition > Math.max(15, configuredStart) &&
      savedPosition < (active.mediaDuration || video.duration) - 30;
    resumePromptHandledRef.current = true;

    if (shouldOfferResume) {
      video.pause();
      setShowResumeModal(true);
    } else if (
      configuredStart > savedPosition &&
      configuredStart < (active.mediaDuration || video.duration)
    ) {
      setSkipBreakpointPosition(configuredStart, configuredStart);
      seekToAbsoluteTime(configuredStart, true, source.playbackMode !== 'direct');
    } else {
      video.play().catch(() => {});
    }
  };

  const clearAudioCompatibilityCheck = useCallback(() => {
    clearTimer(audioCompatibilityTimerRef);
  }, []);

  const checkForUnsupportedAudio = useCallback(() => {
    clearAudioCompatibilityCheck();
    if (useTranscode || isMuted || volume === 0) return;

    audioCompatibilityTimerRef.current = setTimeout(() => {
      const video = videoRef.current as
        (HTMLVideoElement & { webkitAudioDecodedByteCount?: number }) | null;

      // Chromium can play the video track of AC-3/E-AC-3/DTS files without
      // raising a media error. In that state the picture advances but no audio
      // frames are decoded, so the normal onError fallback never runs.
      if (
        video &&
        !video.paused &&
        video.currentTime > 3 &&
        typeof video.webkitAudioDecodedByteCount === 'number' &&
        video.webkitAudioDecodedByteCount === 0
      ) {
        automaticFallbackModesTriedRef.current = new Set([
          source.playbackMode,
          compatibilityMode,
        ]);
        automaticFallbackPendingModeRef.current = compatibilityMode;
        suppressNextEpisode();
        resumeAfterSourceChangeRef.current = compatibilityMode;
        const playbackPosition = Math.max(
          0,
          video.currentTime + timelineOffset - AUDIO_COMPATIBILITY_REWIND_SECONDS,
        );
        dispatchSource({
          type: 'setMode',
          playbackMode: compatibilityMode,
          offsetSeconds: Math.floor(playbackPosition),
        });
      }
    }, AUDIO_COMPATIBILITY_PROBE_MS);
  }, [
    clearAudioCompatibilityCheck,
    compatibilityMode,
    dispatchSource,
    isMuted,
    source.playbackMode,
    suppressNextEpisode,
    timelineOffset,
    useTranscode,
    volume,
  ]);

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;

    // Native HLS load() temporarily reports zero. Keep the saved position on
    // screen until metadata can restore the media element to that position.
    const localPlaybackTime =
      source.playbackMode === 'hls'
        ? (getHlsRecoveryPosition() ?? video.currentTime)
        : video.currentTime;
    const playbackPosition = localPlaybackTime + timelineOffset;
    let previousSkipBreakpointPosition = previousSkipBreakpointPositionRef.current;
    let suppressSkipBreakpointCheck = false;
    if (skipBreakpointEpisodeKeyRef.current !== initialPositionKey) {
      setSkipBreakpointPosition(playbackPosition);
      previousSkipBreakpointPosition = null;
      suppressSkipBreakpointCheck = true;
    } else if (pendingSkipBreakpointTargetRef.current !== null) {
      suppressSkipBreakpointCheck = true;
      const pendingTarget = pendingSkipBreakpointTargetRef.current;
      if (playbackPosition >= pendingTarget - 0.5) {
        pendingSkipBreakpointTargetRef.current = null;
      }
      previousSkipBreakpointPositionRef.current = playbackPosition;
    } else {
      previousSkipBreakpointPositionRef.current = playbackPosition;
    }
    latestPlaybackStateRef.current.position = playbackPosition;
    setCurrentTime(playbackPosition);

    // Safari can emit a transient waiting/stalled event while it still has a
    // healthy forward buffer, and may not emit a matching playing event.
    // Advancing media time is authoritative proof that playback is not stuck.
    if (!video.paused && localPlaybackTime > lastTimeUpdateRef.current + 0.01) {
      setIsBuffering(false);
      setConnectionMessage(null);
      clearTimer(stallRecoveryTimerRef);
    }
    lastTimeUpdateRef.current = localPlaybackTime;

    if (video.buffered.length > 0) {
      setBufferedTime(video.buffered.end(video.buffered.length - 1) + timelineOffset);
    }

    const reportedDuration = active.mediaDuration || video.duration;
    if (!Number.isFinite(reportedDuration) || reportedDuration <= 0) return;

    const completionAt =
      media.type === 'series'
        ? resolveSeriesCompletionAtSeconds(reportedDuration, active)
        : active.completeAtSeconds;
    const hasCustomCompletion = completionAt !== null;
    if (hasCustomCompletion && playbackPosition >= completionAt) {
      if (!completionThresholdTriggeredRef.current) {
        completionThresholdTriggeredRef.current = true;
        saveProgress(true, playbackPosition);
      }
      if (
        active.nextEpisode &&
        autoPlayNext &&
        !nextEpisodeDismissedRef.current &&
        !showNextEpisodeModal
      ) {
        setShowNextEpisodeModal(true);
      }
      return;
    }

    if (
      !suppressSkipBreakpointCheck &&
      previousSkipBreakpointPosition !== null &&
      playbackPosition > previousSkipBreakpointPosition
    ) {
      const breakpoint = active.skipBreakpoints.find(
        ({ triggerSeconds, targetSeconds }) =>
          triggerSeconds < reportedDuration &&
          targetSeconds < reportedDuration &&
          previousSkipBreakpointPosition < triggerSeconds &&
          playbackPosition >= triggerSeconds &&
          playbackPosition < targetSeconds,
      );
      if (breakpoint) {
        setSkipBreakpointPosition(breakpoint.targetSeconds, breakpoint.targetSeconds);
        seekToAbsoluteTime(breakpoint.targetSeconds, true, source.playbackMode !== 'direct');
        return;
      }
    }

    if (Date.now() < suppressNextEpisodeUntilRef.current) return;
    if (
      !Number.isFinite(playbackPosition) ||
      playbackPosition < 30 ||
      playbackPosition > reportedDuration + 1
    ) {
      return;
    }

    // Start series autoplay at the same point the backend marks the episode
    // complete, avoiding a transition that leaves the saved progress unfinished.
    const remainingSeconds = reportedDuration - playbackPosition;
    const percentage = (playbackPosition / reportedDuration) * 100;
    const savedDurationSeconds = Math.floor(reportedDuration);
    const savedPositionSeconds = Math.floor(playbackPosition);
    const savedPercentage =
      savedDurationSeconds > 0 ? (savedPositionSeconds / savedDurationSeconds) * 100 : 0;
    const isNearEnd =
      media.type === 'series'
        ? savedPercentage >= DEFAULT_SERIES_COMPLETION_THRESHOLD_PERCENT && savedPercentage <= 100
        : (remainingSeconds >= 0 && remainingSeconds <= 15) ||
          (percentage >= 94 && percentage <= 100);
    const hasUpcomingSkipBreakpoint =
      autoPlayNext &&
      active.nextEpisode &&
      active.skipBreakpoints.some(
        ({ triggerSeconds, targetSeconds }) =>
          triggerSeconds < reportedDuration &&
          targetSeconds < reportedDuration &&
          playbackPosition < triggerSeconds,
      );

    if (
      isNearEnd &&
      !completionThresholdTriggeredRef.current &&
      !hasUpcomingSkipBreakpoint &&
      !showNextEpisodeModal &&
      !nextEpisodeDismissedRef.current &&
      active.nextEpisode
    ) {
      completionThresholdTriggeredRef.current = true;
      saveProgress(true, playbackPosition);
      if (autoPlayNext) setShowNextEpisodeModal(true);
    }
  };

  const updateBufferedTime = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.buffered.length === 0) return;

    for (let index = 0; index < video.buffered.length; index++) {
      const start = video.buffered.start(index);
      const end = video.buffered.end(index);
      if (video.currentTime >= start && video.currentTime <= end) {
        setBufferedTime(end + timelineOffset);
        return;
      }
    }
  }, [timelineOffset]);

  const handleWaiting = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.paused) return;

    // `stalled` describes network activity, not necessarily exhausted media.
    // Safari frequently reports it with tens of seconds still playable.
    if (getBufferedAheadSeconds(video) >= 1) {
      setIsBuffering(false);
      clearTimer(stallRecoveryTimerRef);
      return;
    }

    if (stallStartedAtRef.current === null) stallStartedAtRef.current = performance.now();
    setIsBuffering(true);
    if (source.playbackMode === 'hls') return; // Owned by the shared HLS recovery budget.
    clearTimer(stallRecoveryTimerRef);

    stallRecoveryTimerRef.current = setTimeout(() => {
      const stalledVideo = videoRef.current;
      if (!stalledVideo || stalledVideo.paused) return;

      // While a transcode is still ramping up, dropping a quality tier is a
      // cheaper fix than restarting the job.
      if (source.playbackMode === 'full' && source.qualityPreference === 'auto') {
        const nextQuality =
          source.effectiveQuality === 'original' || source.effectiveQuality === '1080p'
            ? '720p'
            : source.effectiveQuality === '720p'
              ? '480p'
              : null;

        if (stalledVideo.currentTime < 10 && nextQuality) {
          suppressNextEpisode();
          setConnectionMessage(t.player.requalifying(nextQuality));
          dispatchSource({ type: 'setAdaptiveQuality', quality: nextQuality });
          return;
        }

        recoveryPositionRef.current = stalledVideo.currentTime + timelineOffset;
        setConnectionMessage(t.player.reconnecting);
        dispatchSource({
          type: 'seekTo',
          offsetSeconds: Math.floor(recoveryPositionRef.current),
        });
        return;
      }

      if (stallRecoveryAttemptsRef.current >= MAX_STALL_RECOVERY_ATTEMPTS) return;
      stallRecoveryAttemptsRef.current += 1;
      recoveryPositionRef.current = stalledVideo.currentTime + timelineOffset;

      if (source.playbackMode === 'audio' || source.playbackMode === 'full') {
        setConnectionMessage(
          t.player.reconnectingAttempt(
            stallRecoveryAttemptsRef.current,
            MAX_STALL_RECOVERY_ATTEMPTS,
          ),
        );
        dispatchSource({
          type: 'seekTo',
          offsetSeconds: Math.floor(recoveryPositionRef.current),
        });
        return;
      }

      setConnectionMessage(
        t.player.reestablishing(stallRecoveryAttemptsRef.current, MAX_STALL_RECOVERY_ATTEMPTS),
      );
      stalledVideo.load();
    }, STALL_RECOVERY_DELAY_MS);
  }, [
    dispatchSource,
    source.effectiveQuality,
    source.playbackMode,
    source.qualityPreference,
    setConnectionMessage,
    suppressNextEpisode,
    timelineOffset,
  ]);

  const handleStalled = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.paused || getBufferedAheadSeconds(video) >= 1) {
      setIsBuffering(false);
      clearTimer(stallRecoveryTimerRef);
      return;
    }
    handleWaiting();
  }, [handleWaiting]);

  const handlePlaying = useCallback(() => {
    latestPlaybackStateRef.current.isPlaying = true;
    const now = performance.now();
    if (!firstFrameReportedRef.current) {
      firstFrameReportedRef.current = true;
      reportTelemetry('first-frame', now - sourceStartedAtRef.current);
    }
    if (stallStartedAtRef.current !== null) {
      reportTelemetry('stall', now - stallStartedAtRef.current);
      stallStartedAtRef.current = null;
    }
    if (seekStartedAtRef.current !== null) {
      reportTelemetry('seek-recovery', now - seekStartedAtRef.current);
      seekStartedAtRef.current = null;
    }
    if (resumeAfterSourceChangeRef.current === source.playbackMode) {
      resumeAfterSourceChangeRef.current = null;
    }

    setIsBuffering(false);
    setConnectionMessage(null);
    clearTimer(stallRecoveryTimerRef);

    // Only forgive earlier stall attempts once playback has actually held.
    clearTimer(stablePlaybackTimerRef);
    stablePlaybackTimerRef.current = setTimeout(() => {
      stallRecoveryAttemptsRef.current = 0;
    }, STABLE_PLAYBACK_RESET_MS);
  }, [reportTelemetry, setConnectionMessage, source.playbackMode]);

  const handleCanPlayReady = useCallback(() => {
    setIsBuffering(false);
    clearTimer(stallRecoveryTimerRef);
  }, []);

  const handleSourceError = useCallback(() => {
    reportTelemetry('error');
    if (source.playbackMode === 'hls') {
      handleHlsSourceError();
      return;
    }

    if (switchToAutomaticFallback(source.playbackMode)) return;

    resumeAfterSourceChangeRef.current = null;
    setErrorState({
      code: 'STREAM_FAILED',
      message: t.player.streamFailed,
      isRetryable: true,
    });
  }, [
    handleHlsSourceError,
    reportTelemetry,
    setErrorState,
    source.playbackMode,
    switchToAutomaticFallback,
  ]);

  const handleVideoEnded = () => {
    const video = videoRef.current;
    const reportedDuration = active.mediaDuration || duration || video?.duration || 0;
    const playbackPosition = (video?.currentTime || 0) + timelineOffset;

    const completionAt =
      media.type === 'series'
        ? resolveSeriesCompletionAtSeconds(reportedDuration, active)
        : active.completeAtSeconds;
    const reachedCustomCompletion = completionAt !== null && playbackPosition >= completionAt;

    if (
      Date.now() < suppressNextEpisodeUntilRef.current ||
      !Number.isFinite(reportedDuration) ||
      reportedDuration <= 0 ||
      !Number.isFinite(playbackPosition) ||
      (!reachedCustomCompletion && playbackPosition < reportedDuration - 15)
    ) {
      return;
    }

    saveProgress(true, playbackPosition);
    if (active.nextEpisode && autoPlayNext && !nextEpisodeDismissedRef.current) {
      setShowNextEpisodeModal(true);
    }
  };

  // --- User controls ------------------------------------------------------
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying) {
      setHlsPlaybackIntent(false);
      resumeAfterSourceChangeRef.current = null;
      video.pause();
      return;
    }
    setHlsPlaybackIntent(true);
    video.play().catch((err: Error) => {
      if (err.name !== 'NotSupportedError') return;
      if (
        switchToAutomaticFallback(
          source.playbackMode,
          Number.isFinite(video.currentTime) ? video.currentTime : undefined,
          true,
        )
      ) {
        return;
      }
      setErrorState({
        code: 'CODEC_NOT_SUPPORTED',
        message: t.player.codecUnsupported,
        isRetryable: false,
      });
    });
  }, [
    isPlaying,
    setErrorState,
    setHlsPlaybackIntent,
    source.playbackMode,
    switchToAutomaticFallback,
  ]);

  const skipBy = useCallback(
    (deltaSeconds: number) => {
      const video = videoRef.current;
      if (!video) return;
      seekToAbsoluteTime(video.currentTime + timelineOffset + deltaSeconds);
    },
    [seekToAbsoluteTime, timelineOffset],
  );
  const skipBackward = useCallback(() => skipBy(-10), [skipBy]);
  const skipForward = useCallback(() => skipBy(10), [skipBy]);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !isMuted;
    setIsMuted(!isMuted);
  }, [isMuted, setIsMuted]);

  const toggleFullscreen = useCallback(() => {
    const video = videoRef.current;
    const container = fullscreenContainerRef?.current ?? playerContainerRef.current;
    if (!video || !container) return;

    setFullscreenError(null);
    void togglePlayerFullscreen(video, container).catch(() => {
      setFullscreenError(t.player.fullscreenUnsupported);
    });
  }, [fullscreenContainerRef]);

  const togglePiP = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (document.pictureInPictureElement) {
      void document.exitPictureInPicture();
    } else {
      void video.requestPictureInPicture();
    }
  }, []);

  const changeVolume = useCallback(
    (nextVolume: number) => {
      const clamped = Math.min(1, Math.max(0, nextVolume));
      setVolume(clamped);
      if (videoRef.current) videoRef.current.volume = clamped;
    },
    [setVolume],
  );

  useKeyboardShortcuts({
    onTogglePlay: togglePlay,
    onSkipBackward: skipBackward,
    onSkipForward: skipForward,
    onVolumeUp: () => changeVolume(volume + 0.1),
    onVolumeDown: () => changeVolume(volume - 0.1),
    onToggleMute: toggleMute,
    onToggleFullscreen: toggleFullscreen,
    onTogglePiP: togglePiP,
    onToggleSubtitles: () => {
      const firstSubtitle = availableSubtitles[0];
      selectSubtitle(activeSubtitleId ? null : firstSubtitle?.id || null);
    },
    onSeekPercent: (percent) => {
      if (duration > 0) seekToAbsoluteTime((percent / 100) * duration);
    },
    onCloseMenu: () => {
      if (document.fullscreenElement) void document.exitFullscreen();
    },
  });

  const handleEpisodeChange = (newEpisodeId: string) => {
    saveProgress(true);
    navigate(`/watch/${media.id}/${newEpisodeId}`);
  };

  const handleRetry = () => {
    setErrorState(null);
    if (source.playbackMode === 'hls') {
      retryHls();
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    video.load();
    video.play().catch(() => {});
  };

  const handleToggleTranscode = () => {
    const video = videoRef.current;
    const playbackPosition =
      video && Number.isFinite(video.currentTime)
        ? video.currentTime + timelineOffset
        : currentTime;
    const nextMode: PlaybackMode =
      source.playbackMode === compatibilityMode ? 'direct' : compatibilityMode;

    suppressNextEpisode();
    automaticFallbackModesTriedRef.current = new Set([nextMode]);
    automaticFallbackPendingModeRef.current = null;
    resumeAfterSourceChangeRef.current =
      isPlaying || Boolean(video && !video.paused) ? nextMode : null;

    if (nextMode !== 'direct') {
      dispatchSource({
        type: 'setMode',
        playbackMode: nextMode,
        offsetSeconds: Math.floor(playbackPosition),
      });
      return;
    }

    // Going back to direct playback restores the absolute timeline, so the
    // current position has to be re-applied once the element reloads.
    recoveryPositionRef.current = playbackPosition;
    dispatchSource({ type: 'setMode', playbackMode: 'direct', offsetSeconds: 0 });
  };

  const handleSelectAudioTrack = (streamIndex: number | null) => {
    const video = videoRef.current;
    const preferredStreamIndex = audioTrackCatalog?.recommendedStreamIndex ?? null;
    const nextStreamIndex = streamIndex ?? preferredStreamIndex;
    const currentStreamIndex = source.selectedAudioTrackIndex ?? preferredStreamIndex;
    if (
      source.playbackMode !== 'direct' &&
      (streamIndex === source.selectedAudioTrackIndex ||
        (streamIndex === null && source.selectedAudioTrackIndex === null) ||
        (streamIndex !== null && nextStreamIndex === currentStreamIndex))
    ) {
      return;
    }

    const nextMode = source.playbackMode === 'direct' ? compatibilityMode : source.playbackMode;
    suppressNextEpisode();
    automaticFallbackModesTriedRef.current = new Set([nextMode]);
    automaticFallbackPendingModeRef.current = null;
    resumeAfterSourceChangeRef.current =
      isPlaying || Boolean(video && !video.paused) ? nextMode : null;
    setIsBuffering(true);
    setConnectionMessage(t.player.audioTracks.switching);
    const playbackPosition =
      video && Number.isFinite(video.currentTime)
        ? video.currentTime + timelineOffset
        : currentTime;
    source.selectAudioTrack(streamIndex, Math.floor(playbackPosition), nextMode);
  };

  const cueStyle = useMemo(
    () => `
    ::cue {
      font-size: ${subtitleFontSize}%;
      background-color: ${subtitleBgColor === 'black' ? 'rgba(0, 0, 0, 0.85)' : 'transparent'};
      text-shadow: ${
        subtitleBgColor === 'shadow'
          ? '2px 2px 4px rgba(0, 0, 0, 0.9), -2px -2px 4px rgba(0, 0, 0, 0.9)'
          : 'none'
      };
      border-radius: 6px;
      padding: 2px 8px;
    }
  `,
    [subtitleBgColor, subtitleFontSize],
  );

  const controlsVisible = areControlsVisible || !isPlaying;

  return (
    <div
      ref={playerContainerRef}
      onMouseMove={resetHideTimer}
      onTouchStart={resetHideTimer}
      className={`fixed inset-x-0 top-0 z-50 flex h-[100dvh] min-h-[100svh] w-screen select-none flex-col justify-between overflow-hidden bg-black ${
        controlsVisible ? '' : 'cursor-none'
      }`}
    >
      <style>{cueStyle}</style>

      {/* Top Navigation Header Bar */}
      <div
        className={`absolute inset-x-0 top-0 z-30 flex items-center gap-3 bg-gradient-to-b from-black/90 via-black/40 to-transparent px-3 pb-8 pt-[calc(env(safe-area-inset-top)+0.75rem)] transition-opacity duration-300 sm:gap-4 sm:p-6 ${
          controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <button
          onClick={() => {
            saveProgress(true);
            navigate(`/media/${media.id}`);
          }}
          className="rounded-full bg-zinc-900/80 p-2.5 text-white backdrop-blur-md transition-colors hover:bg-zinc-800 sm:p-3"
          aria-label={t.player.goBack}
        >
          <ArrowLeft className="h-5 w-5 sm:h-6 sm:w-6" />
        </button>
        <h2 className="truncate font-display text-base font-bold text-white sm:text-lg">
          {active.title}
        </h2>
      </div>

      {/* Buffering Center Spinner */}
      {(isBuffering || shouldDelayPlaybackForPlan) && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-950/80 px-6 py-5 backdrop-blur-md">
            <Loader2 className="h-10 w-10 animate-spin text-brand-500" />
            <span className="text-xs font-semibold text-zinc-300">
              {connectionMessage ||
                (shouldDelayPlaybackForPlan ? t.player.audioTracks.loading : t.player.buffering)}
            </span>
          </div>
        </div>
      )}

      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- caption tracks are rendered below from the resolved subtitle list */}
      <video
        ref={videoRef}
        src={
          shouldDelayPlaybackForPlan || (source.playbackMode === 'hls' && !isSafari)
            ? undefined
            : source.sourceUrl
        }
        onPlay={() => {
          latestPlaybackStateRef.current.isPlaying = true;
          setIsPlaying(true);
          checkForUnsupportedAudio();
        }}
        onPause={() => {
          if (!videoRef.current?.error) latestPlaybackStateRef.current.isPlaying = false;
          setIsPlaying(false);
          clearAudioCompatibilityCheck();
        }}
        onWaiting={handleWaiting}
        onStalled={handleStalled}
        onPlaying={handlePlaying}
        onCanPlay={handleCanPlayReady}
        onProgress={updateBufferedTime}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={handleVideoEnded}
        onError={handleSourceError}
        onClick={togglePlay}
        className={`h-full w-full ${
          controlsVisible ? 'cursor-pointer' : 'cursor-none'
        } object-contain transition-all duration-500 ${
          cinemaMode
            ? 'scale-[0.94] rounded-2xl border border-amber-500/20 shadow-[0_0_100px_rgba(245,158,11,0.2)]'
            : ''
        }`}
        playsInline
      >
        {resolvedSubtitles.map((subtitle) => (
          <track
            key={subtitle.id}
            src={getNativeSubtitleSource(subtitle)}
            kind="subtitles"
            srcLang={subtitle.language}
            label={subtitle.label || (subtitle.language || 'und').toUpperCase()}
            default={activeSubtitleId === subtitle.id || (subtitle.isDefault && !activeSubtitleId)}
            onLoad={markTrackLoaded}
          />
        ))}
      </video>

      {activeOverlayCue && !isNativeVideoFullscreen && (
        <div
          className="pointer-events-none absolute inset-x-4 bottom-36 z-30 flex justify-center text-center sm:bottom-24"
          data-testid="subtitle-overlay"
        >
          <span
            className="whitespace-pre-line rounded-md px-3 py-1.5 font-semibold leading-snug text-white"
            style={{
              fontSize: `${subtitleFontSize}%`,
              backgroundColor: subtitleBgColor === 'black' ? 'rgba(0, 0, 0, 0.85)' : 'transparent',
              textShadow:
                subtitleBgColor === 'shadow'
                  ? '2px 2px 4px rgba(0, 0, 0, 0.95), -2px -2px 4px rgba(0, 0, 0, 0.95)'
                  : 'none',
            }}
          >
            {activeOverlayCue.text}
          </span>
        </div>
      )}

      {delayToast && (
        <div className="absolute left-1/2 top-16 z-50 flex -translate-x-1/2 items-center gap-2 rounded-2xl border border-brand-500/40 bg-zinc-950/90 px-4 py-2 text-xs font-bold text-white shadow-2xl backdrop-blur-md animate-fade-in">
          <Clock className="h-4 w-4 text-brand-400" />
          <span>{delayToast}</span>
        </div>
      )}

      {fullscreenError && (
        <div
          role="alert"
          className="absolute left-1/2 top-[calc(env(safe-area-inset-top)+4.5rem)] z-50 -translate-x-1/2 rounded-xl border border-red-500/30 bg-zinc-950/95 px-4 py-2 text-center text-xs font-semibold text-red-300 shadow-2xl"
        >
          {fullscreenError}
        </div>
      )}

      {showResumeModal && (
        <ResumeOverlay
          savedPositionSeconds={active.progress?.positionSeconds || 0}
          onResume={() => {
            if (active.progress?.positionSeconds) {
              setSkipBreakpointPosition(
                active.progress.positionSeconds,
                active.progress.positionSeconds,
              );
              seekToAbsoluteTime(
                active.progress.positionSeconds,
                true,
                source.playbackMode !== 'direct',
              );
            }
            setShowResumeModal(false);
          }}
          onRestart={() => {
            setSkipBreakpointPosition(active.startAtSeconds, active.startAtSeconds);
            seekToAbsoluteTime(active.startAtSeconds);
            setShowResumeModal(false);
          }}
        />
      )}

      {showNextEpisodeModal && active.nextEpisode && (
        <NextEpisodeOverlay
          nextEpisodeTitle={active.nextEpisode.title}
          seasonNumber={active.nextEpisode.seasonNumber}
          episodeNumber={active.nextEpisode.episodeNumber}
          stillUrl={active.nextEpisode.stillUrl}
          posterUrl={media.posterUrl}
          overview={active.nextEpisode.overview}
          onPlayNext={() => {
            setShowNextEpisodeModal(false);
            handleEpisodeChange(active.nextEpisode!.id);
          }}
          onCancel={() => {
            nextEpisodeDismissedRef.current = true;
            setShowNextEpisodeModal(false);
          }}
        />
      )}

      {errorState && (
        <PlayerError
          error={errorState}
          retryLabel={source.playbackMode === 'hls' ? t.player.error.retryStream : undefined}
          onRetry={handleRetry}
        />
      )}

      {/* Controls Overlay Bar */}
      <div
        className={`transition-opacity duration-300 ${
          controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <PlayerControls
          key={active.driveFileId || media.id}
          mediaId={media.id}
          previewDriveFileId={active.driveFileId || undefined}
          seasonNumber={active.seasonNumber}
          episodeNumber={active.episodeNumber}
          isPlaying={isPlaying}
          currentTime={currentTime}
          duration={duration}
          bufferedTime={bufferedTime}
          volume={volume}
          isMuted={isMuted}
          playbackSpeed={playbackSpeed}
          audioTracks={audioTracks}
          preferredAudioLanguage={audioTrackCatalog?.preferredLanguage || 'pt-BR'}
          recommendedAudioTrackIndex={audioTrackCatalog?.recommendedStreamIndex ?? null}
          selectedAudioTrackIndex={source.selectedAudioTrackIndex}
          audioTrackCatalogStatus={audioTrackCatalogStatus}
          onRetryAudioTracks={() => audioTrackCatalogQuery.refetch()}
          canDisableCompatibilityMode={
            audioTrackCatalogStatus === 'ready' &&
            !(
              getBrowserFamily(isSafari) === 'chromium' &&
              activeAudioTrack &&
              requiresChromiumAudioCompatibility(activeAudioTrack.codec)
            ) &&
            (audioTracks.length <= 1 || activeAudioTrack?.isDefault === true)
          }
          compatibilityModeDisabledMessage={
            audioTrackCatalogStatus === 'loading'
              ? t.player.audioTracks.loading
              : audioTrackCatalogStatus === 'error'
                ? t.player.audioTracks.unavailable
                : t.player.controls.transcodeRequiredForAudio
          }
          subtitles={resolvedSubtitles}
          activeSubtitleId={activeSubtitleId}
          hasPreviousEpisode={!!active.previousEpisode}
          hasNextEpisode={!!active.nextEpisode}
          useTranscode={useTranscode && !shouldDelayPlaybackForPlan}
          qualityPreference={source.qualityPreference}
          effectiveQuality={source.effectiveQuality}
          showQualityControl={source.playbackMode === 'full'}
          onSelectQuality={(quality) => {
            suppressNextEpisode();
            source.selectQuality(quality);
          }}
          onToggleTranscode={handleToggleTranscode}
          onTogglePlay={togglePlay}
          onSkipBackward={skipBackward}
          onSkipForward={skipForward}
          onSeek={seekToAbsoluteTime}
          onVolumeChange={changeVolume}
          onToggleMute={toggleMute}
          onSelectSpeed={(speed) => {
            setPlaybackSpeed(speed);
            if (videoRef.current) videoRef.current.playbackRate = speed;
          }}
          onSelectSubtitle={selectSubtitle}
          onSelectAudioTrack={handleSelectAudioTrack}
          onUploadCustomSubtitle={subtitles.uploadCustomSubtitle}
          onSelectOpenSubtitle={handleSelectOpenSubtitle}
          onTogglePiP={togglePiP}
          onToggleFullscreen={toggleFullscreen}
          onPreviousEpisode={
            active.previousEpisode
              ? () => handleEpisodeChange(active.previousEpisode!.id)
              : undefined
          }
          onNextEpisode={
            active.nextEpisode ? () => handleEpisodeChange(active.nextEpisode!.id) : undefined
          }
        />
      </div>
    </div>
  );
};
