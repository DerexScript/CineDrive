import React from 'react';
import { Check, Volume2 } from 'lucide-react';
import type { AudioTrackDto, PreferredAudioLanguage } from '../../../hooks/useApi';
import { t } from '../../../i18n';

interface AudioTrackMenuProps {
  tracks: AudioTrackDto[];
  preferredLanguage: PreferredAudioLanguage;
  recommendedStreamIndex: number | null;
  selectedStreamIndex: number | null;
  onSelectTrack: (streamIndex: number | null) => void;
  onClose: () => void;
}

const languageLabel = (language: string | null) => {
  switch (language?.toLowerCase()) {
    case 'pt-br':
      return t.settings.audioPlayback.options.ptBR;
    case 'pt-pt':
      return t.settings.audioPlayback.options.ptPT;
    case 'pt':
    case 'por':
      return t.player.audioTracks.portuguese;
    case 'en':
    case 'eng':
      return t.player.audioTracks.english;
    case 'es':
    case 'spa':
      return t.player.audioTracks.spanish;
    case 'ja':
    case 'jpn':
      return t.player.audioTracks.japanese;
    default:
      return language || t.player.audioTracks.unknownLanguage;
  }
};

const preferredLanguageLabel = (language: PreferredAudioLanguage) => {
  switch (language) {
    case 'pt-BR':
      return t.settings.audioPlayback.options.ptBR;
    case 'pt-PT':
      return t.settings.audioPlayback.options.ptPT;
    case 'en':
      return t.settings.audioPlayback.options.en;
    case 'auto':
      return t.settings.audioPlayback.options.auto;
  }
};

export const AudioTrackMenu: React.FC<AudioTrackMenuProps> = ({
  tracks,
  preferredLanguage,
  recommendedStreamIndex,
  selectedStreamIndex,
  onSelectTrack,
  onClose,
}) => {
  const effectiveStreamIndex = selectedStreamIndex ?? recommendedStreamIndex;

  return (
    <div
      role="dialog"
      aria-label={t.player.audioTracks.heading}
      className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+8.5rem)] z-50 w-auto rounded-2xl border border-zinc-800 bg-zinc-900/95 p-2 text-zinc-100 shadow-2xl backdrop-blur-xl animate-in fade-in duration-150 sm:absolute sm:inset-x-auto sm:bottom-16 sm:right-28 sm:w-80"
    >
      <div className="mb-1 flex items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs font-bold text-zinc-400">
        <Volume2 className="h-4 w-4" />
        {t.player.audioTracks.heading}
      </div>

      <button
        type="button"
        onClick={() => {
          onSelectTrack(null);
          onClose();
        }}
        className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-xs font-medium transition-colors ${
          selectedStreamIndex === null
            ? 'bg-brand-600/20 text-brand-300'
            : 'text-zinc-300 hover:bg-zinc-800'
        }`}
      >
        <span className="min-w-0">
          <span className="block truncate">{t.player.audioTracks.usePreferred}</span>
          <span className="mt-0.5 block truncate text-[11px] text-zinc-500">
            {preferredLanguageLabel(preferredLanguage)}
          </span>
        </span>
        {selectedStreamIndex === null && <Check className="h-3.5 w-3.5 shrink-0" />}
      </button>

      <div className="my-1 border-t border-zinc-800" />

      <div className="max-h-60 space-y-0.5 overflow-y-auto">
        {tracks.map((track) => {
          const active = effectiveStreamIndex === track.streamIndex;
          const language = languageLabel(track.language);
          const details = [language, track.codec.toUpperCase(), track.channelLayout]
            .filter(Boolean)
            .join(' · ');

          return (
            <button
              key={track.streamIndex}
              type="button"
              onClick={() => {
                onSelectTrack(track.streamIndex);
                onClose();
              }}
              className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition-colors ${
                active ? 'bg-brand-600/20 text-brand-300' : 'text-zinc-300 hover:bg-zinc-800'
              }`}
            >
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium">
                  {track.title || language}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-zinc-500">
                  {details}
                  {track.isDefault ? ` · ${t.player.audioTracks.defaultTrack}` : ''}
                </span>
              </span>
              {active && <Check className="h-3.5 w-3.5 shrink-0" />}
            </button>
          );
        })}
      </div>
    </div>
  );
};
