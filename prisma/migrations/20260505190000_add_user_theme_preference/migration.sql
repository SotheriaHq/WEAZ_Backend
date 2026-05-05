-- Add user-level saved appearance preference. The client resolves system to
-- light/dark at runtime; only the saved preference is stored here.
ALTER TABLE "User"
ADD COLUMN "themePreference" TEXT NOT NULL DEFAULT 'system';

ALTER TABLE "User"
ADD CONSTRAINT "User_themePreference_check"
CHECK ("themePreference" IN ('light', 'dark', 'system'));
