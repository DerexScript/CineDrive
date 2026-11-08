ALTER TABLE "User" ADD COLUMN "preferredAudioLanguage" TEXT NOT NULL DEFAULT 'pt-BR';

ALTER TABLE "DriveFile" ADD COLUMN "audioTracksJson" TEXT;
ALTER TABLE "DriveFile" ADD COLUMN "audioTracksFingerprint" TEXT;
