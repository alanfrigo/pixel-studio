-- Resultados por parte (cartão I1): um envio pode devolver várias candidatas
-- (PixelLab devolve até 64 por job; OpenRouter pode devolver menos que n).
-- Cada resposta bruta é gravada assim que chega; o processamento local fica por resultado.
CREATE TABLE job_part_results (
  job_id TEXT NOT NULL,
  part_key TEXT NOT NULL,
  idx INTEGER NOT NULL CHECK (idx >= 0),
  blob_sha256 TEXT NOT NULL REFERENCES blobs (sha256),
  mime TEXT NOT NULL,
  processed_json TEXT CHECK (processed_json IS NULL OR json_valid(processed_json)),
  PRIMARY KEY (job_id, part_key, idx),
  FOREIGN KEY (job_id, part_key) REFERENCES job_parts (job_id, part_key) ON DELETE CASCADE
) STRICT;
CREATE INDEX job_part_results_by_blob ON job_part_results (blob_sha256);
