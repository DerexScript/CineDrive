import type { MusicTrackDto } from '@cinedrive/shared';
import { intlLocale } from '../../i18n';

export const rankArtistTracks = (tracks: MusicTrackDto[], limit = 5) =>
  [...tracks]
    .sort(
      (left, right) =>
        (right.playCount || 0) - (left.playCount || 0) ||
        Number(right.isFavorite) - Number(left.isFavorite) ||
        (right.year || right.album?.year || 0) - (left.year || left.album?.year || 0) ||
        left.title.localeCompare(right.title, intlLocale),
    )
    .slice(0, limit);
