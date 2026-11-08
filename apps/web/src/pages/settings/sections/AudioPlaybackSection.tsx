import React from 'react';
import { Languages } from 'lucide-react';
import {
  type PreferredAudioLanguage,
  usePlaybackSettingsQuery,
  useUpdatePlaybackSettingsMutation,
} from '../../../hooks/useApi';
import { useSyncedState } from '../../../hooks/useSyncedState';
import { toast } from '../../../stores/useToastStore';
import { t } from '../../../i18n';
import {
  SettingsButton,
  SettingsCard,
  SettingsField,
  SETTINGS_INPUT_CLASSES,
} from '../SettingsCard';

export const AudioPlaybackSection: React.FC = () => {
  const { data: settings, isLoading } = usePlaybackSettingsQuery();
  const updateSettings = useUpdatePlaybackSettingsMutation();
  const [preferredLanguage, setPreferredLanguage] = useSyncedState<PreferredAudioLanguage>(
    settings?.preferredAudioLanguage || 'pt-BR',
  );

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    updateSettings.mutate(
      { preferredAudioLanguage: preferredLanguage },
      {
        onSuccess: () => toast.success(t.settings.audioPlayback.saved),
        onError: (error) => toast.fromError(error, t.settings.audioPlayback.saveFailed),
      },
    );
  };

  return (
    <SettingsCard
      id="settings-audio-playback"
      title={t.settings.audioPlayback.title}
      description={t.settings.audioPlayback.description}
      icon={Languages}
    >
      <form onSubmit={save} className="space-y-4">
        <SettingsField
          id="settings-preferred-audio-language"
          label={t.settings.audioPlayback.preferredLanguage}
          hint={t.settings.audioPlayback.hint}
        >
          <select
            id="settings-preferred-audio-language"
            value={preferredLanguage}
            onChange={(event) => setPreferredLanguage(event.target.value as PreferredAudioLanguage)}
            disabled={isLoading}
            className={SETTINGS_INPUT_CLASSES}
          >
            <option value="pt-BR">{t.settings.audioPlayback.options.ptBR}</option>
            <option value="pt-PT">{t.settings.audioPlayback.options.ptPT}</option>
            <option value="en">{t.settings.audioPlayback.options.en}</option>
            <option value="auto">{t.settings.audioPlayback.options.auto}</option>
          </select>
        </SettingsField>

        <div className="flex justify-end">
          <SettingsButton
            type="submit"
            disabled={isLoading}
            isLoading={updateSettings.isPending}
            loadingLabel={t.settings.audioPlayback.saving}
          >
            {t.settings.audioPlayback.save}
          </SettingsButton>
        </div>
      </form>
    </SettingsCard>
  );
};
