import React, { useEffect, useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  MAX_PLAYBACK_SKIP_BREAKPOINTS,
  playbackSkipBreakpointsSchema,
  type PlaybackSkipBreakpoint,
} from '@cinedrive/shared';
import {
  useUpdateEpisodePlaybackSettingsMutation,
  useUpdateSeriesPlaybackSettingsMutation,
} from '../../hooks/useApi';
import { toast } from '../../stores/useToastStore';
import { t } from '../../i18n';
import type { EpisodeType } from '../../types/media';

const inputClasses =
  'mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40';
const EMPTY_SKIP_BREAKPOINTS: PlaybackSkipBreakpoint[] = [];

interface SkipBreakpointDraft {
  triggerSeconds: string;
  targetSeconds: string;
}

const toSkipBreakpointDrafts = (breakpoints: PlaybackSkipBreakpoint[]): SkipBreakpointDraft[] =>
  breakpoints.map((breakpoint) => ({
    triggerSeconds: String(breakpoint.triggerSeconds),
    targetSeconds: String(breakpoint.targetSeconds),
  }));

const parseSeconds = (value: string, min = 0): number | null | undefined => {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= 360000 ? parsed : undefined;
};

const SecondsField: React.FC<{
  id: string;
  label: string;
  value: string;
  min?: number;
  placeholder?: string;
  onChange: (value: string) => void;
}> = ({ id, label, value, min = 0, placeholder, onChange }) => (
  <label htmlFor={id} className="block text-sm font-medium text-zinc-200">
    {label}
    <input
      id={id}
      type="number"
      min={min}
      max={360000}
      step={1}
      inputMode="numeric"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className={inputClasses}
    />
  </label>
);

const SkipBreakpointsEditor: React.FC<{
  idPrefix: string;
  drafts: SkipBreakpointDraft[];
  onChange: (drafts: SkipBreakpointDraft[]) => void;
}> = ({ idPrefix, drafts, onChange }) => (
  <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h3 className="text-sm font-semibold text-zinc-200">
          {t.mediaDetail.playbackSettings.skipBreakpointsTitle}
        </h3>
        <p className="mt-1 text-xs text-zinc-500">
          {t.mediaDetail.playbackSettings.skipBreakpointsDescription}
        </p>
      </div>
      <button
        type="button"
        disabled={drafts.length >= MAX_PLAYBACK_SKIP_BREAKPOINTS}
        onClick={() => onChange([...drafts, { triggerSeconds: '', targetSeconds: '' }])}
        className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus className="h-3.5 w-3.5" />
        {t.mediaDetail.playbackSettings.addBreakpoint}
      </button>
    </div>

    {drafts.length === 0 ? (
      <p className="rounded-lg border border-dashed border-zinc-800 px-3 py-3 text-xs text-zinc-500">
        {t.mediaDetail.playbackSettings.noBreakpoints}
      </p>
    ) : (
      <div className="space-y-2">
        {drafts.map((draft, index) => (
          <div
            key={`${idPrefix}-${index}`}
            className="grid items-end gap-3 rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 sm:grid-cols-[1fr_1fr_auto]"
          >
            <SecondsField
              id={`${idPrefix}-trigger-${index}`}
              label={t.mediaDetail.playbackSettings.breakpointTrigger}
              value={draft.triggerSeconds}
              min={1}
              placeholder="e.g. 420"
              onChange={(triggerSeconds) =>
                onChange(
                  drafts.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, triggerSeconds } : item,
                  ),
                )
              }
            />
            <SecondsField
              id={`${idPrefix}-target-${index}`}
              label={t.mediaDetail.playbackSettings.breakpointTarget}
              value={draft.targetSeconds}
              min={1}
              placeholder="e.g. 510"
              onChange={(targetSeconds) =>
                onChange(
                  drafts.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, targetSeconds } : item,
                  ),
                )
              }
            />
            <button
              type="button"
              aria-label={t.mediaDetail.playbackSettings.removeBreakpoint}
              title={t.mediaDetail.playbackSettings.removeBreakpoint}
              onClick={() => onChange(drafts.filter((_, itemIndex) => itemIndex !== index))}
              className="mb-0.5 inline-flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-700 text-zinc-400 transition-colors hover:border-rose-500/50 hover:bg-rose-500/10 hover:text-rose-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    )}

    <p className="text-xs text-zinc-500">
      {t.mediaDetail.playbackSettings.breakpointLimit(MAX_PLAYBACK_SKIP_BREAKPOINTS)}
    </p>
  </div>
);

const parseSkipBreakpointDrafts = (
  drafts: SkipBreakpointDraft[],
): PlaybackSkipBreakpoint[] | undefined => {
  const parsedBreakpoints: PlaybackSkipBreakpoint[] = [];
  for (const draft of drafts) {
    const triggerSeconds = parseSeconds(draft.triggerSeconds, 1);
    const targetSeconds = parseSeconds(draft.targetSeconds, 1);
    if (typeof triggerSeconds !== 'number' || typeof targetSeconds !== 'number') return undefined;
    parsedBreakpoints.push({ triggerSeconds, targetSeconds });
  }

  const validated = playbackSkipBreakpointsSchema.safeParse(parsedBreakpoints);
  if (!validated.success) return undefined;
  return [...validated.data].sort((left, right) => left.triggerSeconds - right.triggerSeconds);
};

interface SeriesPlaybackSettingsProps {
  mediaId: string;
  startAtSeconds?: number | null;
  completeAtSeconds?: number | null;
  skipBreakpoints?: PlaybackSkipBreakpoint[] | null;
}

export const SeriesPlaybackSettings: React.FC<SeriesPlaybackSettingsProps> = ({
  mediaId,
  startAtSeconds,
  completeAtSeconds,
  skipBreakpoints,
}) => {
  const mutation = useUpdateSeriesPlaybackSettingsMutation();
  const [startAt, setStartAt] = useState(startAtSeconds == null ? '' : String(startAtSeconds));
  const [completeAt, setCompleteAt] = useState(
    completeAtSeconds == null ? '' : String(completeAtSeconds),
  );
  const [skipBreakpointDrafts, setSkipBreakpointDrafts] = useState(() =>
    toSkipBreakpointDrafts(skipBreakpoints ?? EMPTY_SKIP_BREAKPOINTS),
  );

  useEffect(() => {
    setStartAt(startAtSeconds == null ? '' : String(startAtSeconds));
    setCompleteAt(completeAtSeconds == null ? '' : String(completeAtSeconds));
  }, [startAtSeconds, completeAtSeconds]);

  useEffect(() => {
    setSkipBreakpointDrafts(toSkipBreakpointDrafts(skipBreakpoints ?? EMPTY_SKIP_BREAKPOINTS));
  }, [skipBreakpoints]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const parsedStartAt = parseSeconds(startAt);
    const parsedCompleteAt = parseSeconds(completeAt, 1);
    const parsedSkipBreakpoints = parseSkipBreakpointDrafts(skipBreakpointDrafts);
    if (parsedStartAt === undefined || parsedCompleteAt === undefined) {
      toast.error(t.mediaDetail.playbackSettings.secondsHint);
      return;
    }
    if (parsedSkipBreakpoints === undefined) {
      toast.error(t.mediaDetail.playbackSettings.invalidBreakpoints);
      return;
    }

    try {
      await mutation.mutateAsync({
        id: mediaId,
        data: {
          startAtSeconds: parsedStartAt,
          completeAtSeconds: parsedCompleteAt,
          skipBreakpoints: parsedSkipBreakpoints,
        },
      });
      toast.success(t.mediaDetail.playbackSettings.saved);
    } catch (error) {
      toast.fromError(error, t.mediaDetail.playbackSettings.saveFailed);
    }
  };

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 md:p-6">
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-white">{t.mediaDetail.playbackSettings.title}</h2>
        <p className="mt-1 text-sm text-zinc-400">
          {t.mediaDetail.playbackSettings.description}{' '}
          {t.mediaDetail.playbackSettings.seriesDescription}
        </p>
      </div>
      <form onSubmit={handleSubmit} className="grid gap-4 md:grid-cols-2">
        <SecondsField
          id={`series-start-${mediaId}`}
          label={t.mediaDetail.playbackSettings.skipOpening}
          value={startAt}
          placeholder={t.mediaDetail.playbackSettings.noOpeningSkip}
          onChange={setStartAt}
        />
        <SecondsField
          id={`series-complete-${mediaId}`}
          label={t.mediaDetail.playbackSettings.markCompleted}
          value={completeAt}
          min={1}
          placeholder={t.mediaDetail.playbackSettings.defaultCompletion}
          onChange={setCompleteAt}
        />
        <div className="md:col-span-2">
          <SkipBreakpointsEditor
            idPrefix={`series-skips-${mediaId}`}
            drafts={skipBreakpointDrafts}
            onChange={setSkipBreakpointDrafts}
          />
        </div>
        <div className="md:col-span-2 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-zinc-500">{t.mediaDetail.playbackSettings.secondsHint}</p>
          <button
            type="submit"
            disabled={mutation.isPending}
            className="cd-primary disabled:opacity-50"
          >
            {mutation.isPending
              ? t.mediaDetail.playbackSettings.saving
              : t.mediaDetail.playbackSettings.save}
          </button>
        </div>
      </form>
    </section>
  );
};

interface EpisodePlaybackSettingsProps {
  mediaId: string;
  episode: EpisodeType;
  seriesSkipBreakpoints?: PlaybackSkipBreakpoint[] | null;
}

export const EpisodePlaybackSettings: React.FC<EpisodePlaybackSettingsProps> = ({
  mediaId,
  episode,
  seriesSkipBreakpoints,
}) => {
  const inheritedSkipBreakpoints = seriesSkipBreakpoints ?? EMPTY_SKIP_BREAKPOINTS;
  const mutation = useUpdateEpisodePlaybackSettingsMutation();
  const [inheritSkipBreakpoints, setInheritSkipBreakpoints] = useState(
    episode.skipBreakpoints == null,
  );
  const [startAt, setStartAt] = useState(
    episode.startAtSeconds == null ? '' : String(episode.startAtSeconds),
  );
  const [completeAt, setCompleteAt] = useState(
    episode.completeAtSeconds == null ? '' : String(episode.completeAtSeconds),
  );
  const [skipBreakpointDrafts, setSkipBreakpointDrafts] = useState(() =>
    toSkipBreakpointDrafts(episode.skipBreakpoints ?? inheritedSkipBreakpoints),
  );

  useEffect(() => {
    setInheritSkipBreakpoints(episode.skipBreakpoints == null);
    setStartAt(episode.startAtSeconds == null ? '' : String(episode.startAtSeconds));
    setCompleteAt(episode.completeAtSeconds == null ? '' : String(episode.completeAtSeconds));
    setSkipBreakpointDrafts(
      toSkipBreakpointDrafts(episode.skipBreakpoints ?? inheritedSkipBreakpoints),
    );
  }, [
    episode.id,
    episode.startAtSeconds,
    episode.completeAtSeconds,
    episode.skipBreakpoints,
    inheritedSkipBreakpoints,
  ]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const parsedStartAt = parseSeconds(startAt);
    const parsedCompleteAt = parseSeconds(completeAt, 1);
    const parsedSkipBreakpoints = inheritSkipBreakpoints
      ? null
      : parseSkipBreakpointDrafts(skipBreakpointDrafts);
    if (parsedStartAt === undefined || parsedCompleteAt === undefined) {
      toast.error(t.mediaDetail.playbackSettings.secondsHint);
      return;
    }
    if (!inheritSkipBreakpoints && parsedSkipBreakpoints === undefined) {
      toast.error(t.mediaDetail.playbackSettings.invalidBreakpoints);
      return;
    }

    try {
      await mutation.mutateAsync({
        mediaId,
        episodeId: episode.id,
        data: {
          startAtSeconds: parsedStartAt,
          completeAtSeconds: parsedCompleteAt,
          skipBreakpoints: parsedSkipBreakpoints,
        },
      });
      toast.success(t.mediaDetail.playbackSettings.episodeSaved);
    } catch (error) {
      toast.fromError(error, t.mediaDetail.playbackSettings.saveFailed);
    }
  };

  return (
    <details className="mt-2 rounded-xl border border-zinc-800/80 bg-zinc-950/50 px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium text-zinc-300 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
        {t.mediaDetail.playbackSettings.episodeOverride}
      </summary>
      <form onSubmit={handleSubmit} className="mt-4 grid gap-4 sm:grid-cols-2">
        <SecondsField
          id={`episode-start-${episode.id}`}
          label={t.mediaDetail.playbackSettings.skipOpening}
          value={startAt}
          placeholder={
            episode.startAtSeconds == null ? t.mediaDetail.playbackSettings.inheritHint : undefined
          }
          onChange={setStartAt}
        />
        <SecondsField
          id={`episode-complete-${episode.id}`}
          label={t.mediaDetail.playbackSettings.markCompleted}
          value={completeAt}
          min={1}
          placeholder={
            episode.completeAtSeconds == null
              ? t.mediaDetail.playbackSettings.inheritHint
              : undefined
          }
          onChange={setCompleteAt}
        />
        <fieldset className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-950/30 p-3 sm:col-span-2">
          <legend className="px-1 text-sm font-medium text-zinc-200">
            {t.mediaDetail.playbackSettings.skipBreakpointsTitle}
          </legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-zinc-300">
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name={`episode-skip-mode-${episode.id}`}
                checked={inheritSkipBreakpoints}
                onChange={() => setInheritSkipBreakpoints(true)}
                className="accent-brand-500"
              />
              {t.mediaDetail.playbackSettings.inheritSeriesBreakpoints}
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name={`episode-skip-mode-${episode.id}`}
                checked={!inheritSkipBreakpoints}
                onChange={() => setInheritSkipBreakpoints(false)}
                className="accent-brand-500"
              />
              {t.mediaDetail.playbackSettings.customizeEpisodeBreakpoints}
            </label>
          </div>
          {inheritSkipBreakpoints ? (
            <p className="text-xs text-zinc-500">
              {t.mediaDetail.playbackSettings.inheritedBreakpoints(inheritedSkipBreakpoints.length)}
            </p>
          ) : (
            <SkipBreakpointsEditor
              idPrefix={`episode-skips-${episode.id}`}
              drafts={skipBreakpointDrafts}
              onChange={setSkipBreakpointDrafts}
            />
          )}
        </fieldset>
        <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-zinc-500">{t.mediaDetail.playbackSettings.inheritHint}</p>
          <button
            type="submit"
            disabled={mutation.isPending}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-white/5 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50"
          >
            {mutation.isPending
              ? t.mediaDetail.playbackSettings.saving
              : t.mediaDetail.playbackSettings.save}
          </button>
        </div>
      </form>
    </details>
  );
};
