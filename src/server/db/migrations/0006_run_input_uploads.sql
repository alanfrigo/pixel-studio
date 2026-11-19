-- Uma fonte de geração pode ser uma revisão ou um upload normalizado.
ALTER TABLE run_inputs RENAME TO run_inputs_previous;

CREATE TABLE run_inputs (
  run_id TEXT NOT NULL REFERENCES generation_runs (id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  revision_id TEXT,
  upload_id TEXT,
  file_key TEXT,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  role TEXT NOT NULL,
  PRIMARY KEY (run_id, ordinal),
  CHECK ((revision_id IS NOT NULL AND upload_id IS NULL) OR
         (revision_id IS NULL AND upload_id IS NOT NULL AND file_key IS NULL))
) STRICT;

INSERT INTO run_inputs (run_id, ordinal, revision_id, file_key, sha256, role)
SELECT run_id, ordinal, revision_id, file_key, sha256, role FROM run_inputs_previous;

DROP TABLE run_inputs_previous;
