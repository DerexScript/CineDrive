import React, { useState, type FormEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { useUpdateSeriesNoteMutation } from '../../hooks/useApi';
import { toast } from '../../stores/useToastStore';
import { t } from '../../i18n';

const MAX_SERIES_NOTE_LENGTH = 10000;

interface SeriesNotesProps {
  mediaId: string;
  personalNote?: string | null;
}

export const SeriesNotes: React.FC<SeriesNotesProps> = ({ mediaId, personalNote }) => {
  const mutation = useUpdateSeriesNoteMutation();
  const savedNote = personalNote ?? '';
  const [note, setNote] = useState(savedNote);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();

    try {
      const updatedNote = await mutation.mutateAsync({ id: mediaId, data: { note } });
      setNote(updatedNote ?? '');
      toast.success(t.mediaDetail.seriesNotes.saved);
    } catch (error) {
      toast.fromError(error, t.mediaDetail.seriesNotes.saveFailed);
    }
  };

  const descriptionId = `series-note-description-${mediaId}`;

  return (
    <details className="group rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 md:p-6">
      <summary className="flex cursor-pointer list-none items-start justify-between gap-4 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 [&::-webkit-details-marker]:hidden">
        <div>
          <h2 className="text-lg font-semibold text-white">{t.mediaDetail.seriesNotes.title}</h2>
          <p id={descriptionId} className="mt-1 text-sm text-zinc-400">
            {t.mediaDetail.seriesNotes.description}
          </p>
        </div>
        <ChevronDown
          aria-hidden="true"
          className="mt-1 h-5 w-5 shrink-0 text-zinc-400 transition-transform group-open:rotate-180"
        />
      </summary>
      <form onSubmit={handleSubmit} className="mt-5 space-y-4">
        <label
          htmlFor={`series-note-${mediaId}`}
          className="block text-sm font-medium text-zinc-200"
        >
          {t.mediaDetail.seriesNotes.label}
          <textarea
            id={`series-note-${mediaId}`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t.mediaDetail.seriesNotes.placeholder}
            maxLength={MAX_SERIES_NOTE_LENGTH}
            rows={6}
            disabled={mutation.isPending}
            aria-describedby={descriptionId}
            className="mt-1 w-full resize-y rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm leading-relaxed text-zinc-100 placeholder:text-zinc-500 focus:border-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 disabled:cursor-wait disabled:opacity-60"
          />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-zinc-500">
            {t.mediaDetail.seriesNotes.characterCount(note.length, MAX_SERIES_NOTE_LENGTH)}
          </p>
          <button
            type="submit"
            disabled={mutation.isPending || note === savedNote}
            className="cd-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {mutation.isPending ? t.mediaDetail.seriesNotes.saving : t.mediaDetail.seriesNotes.save}
          </button>
        </div>
      </form>
    </details>
  );
};
