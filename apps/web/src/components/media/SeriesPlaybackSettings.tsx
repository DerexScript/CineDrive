import React, { useRef, useState, type FormEvent } from 'react';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
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

type CompletionRuleMode = 'inherit' | 'default' | 'fixed' | 'remaining';
type CompletionRuleDraft =
  { mode: 'inherit' | 'default' } | { mode: 'fixed' | 'remaining'; seconds: string };

const toCompletionRuleDraft = (
  completeAtSeconds: number | null | undefined,
  completeBeforeEndSeconds: number | null | undefined,
  inherited: boolean,
): CompletionRuleDraft => {
  if (completeBeforeEndSeconds != null) {
    return { mode: 'remaining', seconds: String(completeBeforeEndSeconds) };
  }
  if (completeAtSeconds != null) return { mode: 'fixed', seconds: String(completeAtSeconds) };
  return { mode: inherited ? 'inherit' : 'default' };
};

const createCompletionRuleDraft = (mode: CompletionRuleMode): CompletionRuleDraft =>
  mode === 'fixed' || mode === 'remaining' ? { mode, seconds: '' } : { mode };

const CompletionRuleEditor: React.FC<{
  idPrefix: string;
  draft: CompletionRuleDraft;
  options: CompletionRuleMode[];
  hint: string;
  onModeChange: (mode: CompletionRuleMode) => void;
  onSecondsChange: (seconds: string) => void;
}> = ({ idPrefix, draft, options, hint, onModeChange, onSecondsChange }) => {
  const labels: Record<CompletionRuleMode, string> = {
    inherit: t.mediaDetail.playbackSettings.completionUseSeries,
    default: t.mediaDetail.playbackSettings.completionUseDefault,
    fixed: t.mediaDetail.playbackSettings.completionAtFixedTime,
    remaining: t.mediaDetail.playbackSettings.completionBeforeEnd,
  };

  return (
    <fieldset className="space-y-3 md:col-span-1">
      <legend className="text-sm font-medium text-zinc-200">
        {t.mediaDetail.playbackSettings.completionRuleTitle}
      </legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-zinc-300">
        {options.map((mode) => (
          <label key={mode} className="inline-flex items-center gap-2">
            <input
              type="radio"
              name={`${idPrefix}-completion-mode`}
              checked={draft.mode === mode}
              onChange={() => onModeChange(mode)}
              className="accent-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            />
            {labels[mode]}
          </label>
        ))}
      </div>
      {draft.mode === 'fixed' && (
        <SecondsField
          id={`${idPrefix}-completion-fixed`}
          label={t.mediaDetail.playbackSettings.markCompleted}
          value={draft.seconds}
          min={1}
          placeholder="e.g. 1200"
          onChange={onSecondsChange}
        />
      )}
      {draft.mode === 'remaining' && (
        <SecondsField
          id={`${idPrefix}-completion-remaining`}
          label={t.mediaDetail.playbackSettings.completeWhenSecondsRemain}
          value={draft.seconds}
          min={1}
          placeholder="e.g. 60"
          onChange={onSecondsChange}
        />
      )}
      <p className="text-xs text-zinc-500">{hint}</p>
    </fieldset>
  );
};

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
  completeBeforeEndSeconds?: number | null;
  skipBreakpoints?: PlaybackSkipBreakpoint[] | null;
}

export const SeriesPlaybackSettings: React.FC<SeriesPlaybackSettingsProps> = ({
  mediaId,
  startAtSeconds,
  completeAtSeconds,
  completeBeforeEndSeconds,
  skipBreakpoints,
}) => {
  const mutation = useUpdateSeriesPlaybackSettingsMutation();
  const [startAt, setStartAt] = useState(startAtSeconds == null ? '' : String(startAtSeconds));
  const [completionDraft, setCompletionDraft] = useState(() =>
    toCompletionRuleDraft(completeAtSeconds, completeBeforeEndSeconds, false),
  );
  const [skipBreakpointDrafts, setSkipBreakpointDrafts] = useState(() =>
    toSkipBreakpointDrafts(skipBreakpoints ?? EMPTY_SKIP_BREAKPOINTS),
  );

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const parsedStartAt = parseSeconds(startAt);
    const parsedSkipBreakpoints = parseSkipBreakpointDrafts(skipBreakpointDrafts);
    if (parsedStartAt === undefined) {
      toast.error(t.mediaDetail.playbackSettings.secondsHint);
      return;
    }
    const parsedCompletionSeconds =
      completionDraft.mode === 'fixed' || completionDraft.mode === 'remaining'
        ? parseSeconds(completionDraft.seconds, 1)
        : null;
    if (
      (completionDraft.mode === 'fixed' || completionDraft.mode === 'remaining') &&
      typeof parsedCompletionSeconds !== 'number'
    ) {
      toast.error(t.mediaDetail.playbackSettings.invalidCompletionSeconds);
      return;
    }
    if (parsedSkipBreakpoints === undefined) {
      toast.error(t.mediaDetail.playbackSettings.invalidBreakpoints);
      return;
    }

    try {
      const updatedMediaItem = await mutation.mutateAsync({
        id: mediaId,
        data: {
          startAtSeconds: parsedStartAt,
          completeAtSeconds: completionDraft.mode === 'fixed' ? parsedCompletionSeconds! : null,
          completeBeforeEndSeconds:
            completionDraft.mode === 'remaining' ? parsedCompletionSeconds! : null,
          skipBreakpoints: parsedSkipBreakpoints,
        },
      });
      setStartAt(
        updatedMediaItem.startAtSeconds == null ? '' : String(updatedMediaItem.startAtSeconds),
      );
      setCompletionDraft(
        toCompletionRuleDraft(
          updatedMediaItem.completeAtSeconds,
          updatedMediaItem.completeBeforeEndSeconds,
          false,
        ),
      );
      setSkipBreakpointDrafts(
        toSkipBreakpointDrafts(updatedMediaItem.skipBreakpoints ?? EMPTY_SKIP_BREAKPOINTS),
      );
      toast.success(t.mediaDetail.playbackSettings.saved);
    } catch (error) {
      toast.fromError(error, t.mediaDetail.playbackSettings.saveFailed);
    }
  };

  return (
    <details className="group rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 md:p-6">
      <summary className="flex cursor-pointer list-none items-start justify-between gap-4 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 [&::-webkit-details-marker]:hidden">
        <div>
          <h2 className="text-lg font-semibold text-white">
            {t.mediaDetail.playbackSettings.title}
          </h2>
          <p className="mt-1 text-sm text-zinc-400">
            {t.mediaDetail.playbackSettings.description}{' '}
            {t.mediaDetail.playbackSettings.seriesDescription}
          </p>
        </div>
        <ChevronDown
          aria-hidden="true"
          className="mt-1 h-5 w-5 shrink-0 text-zinc-400 transition-transform group-open:rotate-180"
        />
      </summary>
      <form onSubmit={handleSubmit} className="mt-5 grid gap-4 md:grid-cols-2">
        <SecondsField
          id={`series-start-${mediaId}`}
          label={t.mediaDetail.playbackSettings.skipOpening}
          value={startAt}
          placeholder={t.mediaDetail.playbackSettings.noOpeningSkip}
          onChange={setStartAt}
        />
        <CompletionRuleEditor
          idPrefix={`series-${mediaId}`}
          draft={completionDraft}
          options={['default', 'fixed', 'remaining']}
          hint={t.mediaDetail.playbackSettings.completionRuleHint}
          onModeChange={(mode) => setCompletionDraft(createCompletionRuleDraft(mode))}
          onSecondsChange={(seconds) =>
            setCompletionDraft((draft) =>
              draft.mode === 'fixed' || draft.mode === 'remaining' ? { ...draft, seconds } : draft,
            )
          }
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
    </details>
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
  const [completionDraft, setCompletionDraft] = useState(() =>
    toCompletionRuleDraft(episode.completeAtSeconds, episode.completeBeforeEndSeconds, true),
  );
  const [skipBreakpointDrafts, setSkipBreakpointDrafts] = useState(() =>
    toSkipBreakpointDrafts(episode.skipBreakpoints ?? inheritedSkipBreakpoints),
  );
  const hasCustomSkipBreakpointDraftRef = useRef(episode.skipBreakpoints != null);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const parsedStartAt = parseSeconds(startAt);
    const parsedCompletionSeconds =
      completionDraft.mode === 'fixed' || completionDraft.mode === 'remaining'
        ? parseSeconds(completionDraft.seconds, 1)
        : null;
    const parsedSkipBreakpoints = inheritSkipBreakpoints
      ? null
      : parseSkipBreakpointDrafts(skipBreakpointDrafts);
    if (parsedStartAt === undefined) {
      toast.error(t.mediaDetail.playbackSettings.secondsHint);
      return;
    }
    if (
      (completionDraft.mode === 'fixed' || completionDraft.mode === 'remaining') &&
      typeof parsedCompletionSeconds !== 'number'
    ) {
      toast.error(t.mediaDetail.playbackSettings.invalidCompletionSeconds);
      return;
    }
    if (!inheritSkipBreakpoints && parsedSkipBreakpoints === undefined) {
      toast.error(t.mediaDetail.playbackSettings.invalidBreakpoints);
      return;
    }

    try {
      const updatedEpisode = await mutation.mutateAsync({
        mediaId,
        episodeId: episode.id,
        data: {
          startAtSeconds: parsedStartAt,
          completeAtSeconds: completionDraft.mode === 'fixed' ? parsedCompletionSeconds! : null,
          completeBeforeEndSeconds:
            completionDraft.mode === 'remaining' ? parsedCompletionSeconds! : null,
          skipBreakpoints: parsedSkipBreakpoints,
        },
      });
      setStartAt(
        updatedEpisode.startAtSeconds == null ? '' : String(updatedEpisode.startAtSeconds),
      );
      setCompletionDraft(
        toCompletionRuleDraft(
          updatedEpisode.completeAtSeconds,
          updatedEpisode.completeBeforeEndSeconds,
          true,
        ),
      );
      setInheritSkipBreakpoints(updatedEpisode.skipBreakpoints == null);
      hasCustomSkipBreakpointDraftRef.current = updatedEpisode.skipBreakpoints != null;
      setSkipBreakpointDrafts(
        toSkipBreakpointDrafts(updatedEpisode.skipBreakpoints ?? inheritedSkipBreakpoints),
      );
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
        <CompletionRuleEditor
          idPrefix={`episode-${episode.id}`}
          draft={completionDraft}
          options={['inherit', 'fixed', 'remaining']}
          hint={t.mediaDetail.playbackSettings.episodeCompletionRuleHint}
          onModeChange={(mode) => setCompletionDraft(createCompletionRuleDraft(mode))}
          onSecondsChange={(seconds) =>
            setCompletionDraft((draft) =>
              draft.mode === 'fixed' || draft.mode === 'remaining' ? { ...draft, seconds } : draft,
            )
          }
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
                onChange={() => {
                  if (!hasCustomSkipBreakpointDraftRef.current) {
                    setSkipBreakpointDrafts(toSkipBreakpointDrafts(inheritedSkipBreakpoints));
                  }
                  hasCustomSkipBreakpointDraftRef.current = true;
                  setInheritSkipBreakpoints(false);
                }}
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
              onChange={(drafts) => {
                hasCustomSkipBreakpointDraftRef.current = true;
                setSkipBreakpointDrafts(drafts);
              }}
            />
          )}
        </fieldset>
        <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-zinc-500">
            {t.mediaDetail.playbackSettings.episodeSettingsHint}
          </p>
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
