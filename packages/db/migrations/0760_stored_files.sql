-- Durable copy of every uploaded file. Railway's container disk is wiped on each deploy, so STORAGE_DIR is only a cache:
-- a file missing on disk is restored from here on first read.
CREATE TABLE IF NOT EXISTS stored_files (
  path text PRIMARY KEY,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
