-- Add the new enum value for banner uploads
ALTER TYPE "FileType" ADD VALUE IF NOT EXISTS 'BANNER_IMAGE';
