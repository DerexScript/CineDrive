ALTER TABLE "MediaItem" ADD COLUMN "startAtSeconds" INTEGER;
ALTER TABLE "MediaItem" ADD COLUMN "completeAtSeconds" INTEGER;

ALTER TABLE "Episode" ADD COLUMN "startAtSeconds" INTEGER;
ALTER TABLE "Episode" ADD COLUMN "completeAtSeconds" INTEGER;
