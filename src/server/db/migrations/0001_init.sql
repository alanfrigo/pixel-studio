-- Modelo lógico inicial (plan/02a-contratos.md §modelo lógico).
-- Convenções: IDs TEXT estáveis; instantes em ISO-8601 UTC (ordenáveis como texto);
-- JSON em TEXT validado; FKs compostas garantem que vínculos fiquem no mesmo projeto.

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  active_style_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (active_style_revision_id, id) REFERENCES style_revisions (id, project_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE style_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  number INTEGER NOT NULL CHECK (number > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'archived')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
  created_at TEXT NOT NULL,
  approved_at TEXT,
  UNIQUE (project_id, number),
  UNIQUE (id, project_id)
) STRICT;

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  family TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  approved_revision_id TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, project_id),
  -- A revisão ativa pertence ao próprio asset.
  FOREIGN KEY (approved_revision_id, id) REFERENCES asset_revisions (id, asset_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX assets_by_project_family ON assets (project_id, family);

CREATE TABLE asset_revisions (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number > 0),
  predecessor_id TEXT REFERENCES asset_revisions (id),
  style_revision_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('candidate', 'approved', 'rejected')),
  schema_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
  origin TEXT NOT NULL CHECK (origin IN ('import', 'generation', 'edit', 'composition', 'local_process')),
  job_attempt_id TEXT REFERENCES job_attempts (id),
  technical_report_json TEXT CHECK (technical_report_json IS NULL OR json_valid(technical_report_json)),
  created_at TEXT NOT NULL,
  UNIQUE (asset_id, number),
  UNIQUE (id, asset_id),
  UNIQUE (id, project_id),
  FOREIGN KEY (asset_id, project_id) REFERENCES assets (id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (style_revision_id, project_id) REFERENCES style_revisions (id, project_id)
) STRICT;
CREATE INDEX asset_revisions_by_asset ON asset_revisions (asset_id, number);

CREATE TABLE revision_edges (
  from_revision_id TEXT NOT NULL,
  to_revision_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  -- 1 = dependência exigida pelo runtime (entra no pacote); 0 = vínculo editorial.
  runtime INTEGER NOT NULL CHECK (runtime IN (0, 1)),
  PRIMARY KEY (from_revision_id, role, ordinal),
  FOREIGN KEY (from_revision_id, project_id) REFERENCES asset_revisions (id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (to_revision_id, project_id) REFERENCES asset_revisions (id, project_id)
) STRICT;
CREATE INDEX revision_edges_by_target ON revision_edges (to_revision_id);

CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  mime TEXT NOT NULL,
  modality TEXT NOT NULL CHECK (modality IN ('raster', 'audio', 'font', 'data')),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE revision_files (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  -- original, raw, normalized, mask, preview, atlas...
  role TEXT NOT NULL,
  idx INTEGER NOT NULL CHECK (idx >= 0),
  -- fileId citado no payload tipado da revisão.
  file_key TEXT NOT NULL,
  blob_sha256 TEXT NOT NULL REFERENCES blobs (sha256),
  UNIQUE (revision_id, role, idx),
  UNIQUE (revision_id, file_key),
  FOREIGN KEY (revision_id, project_id) REFERENCES asset_revisions (id, project_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX revision_files_by_blob ON revision_files (blob_sha256);

CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  blob_sha256 TEXT NOT NULL REFERENCES blobs (sha256),
  normalized_sha256 TEXT REFERENCES blobs (sha256),
  modality TEXT NOT NULL CHECK (modality IN ('raster', 'audio', 'font', 'data')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'rejected')),
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  ingest_job_id TEXT REFERENCES jobs (id),
  -- Upload provisório expira se não for vinculado a uma revisão ou plano.
  expires_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (id, project_id)
) STRICT;
CREATE INDEX uploads_by_project ON uploads (project_id, created_at);

CREATE TABLE asset_drafts (
  asset_id TEXT PRIMARY KEY REFERENCES assets (id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE provider_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT NOT NULL,
  base_url TEXT,
  -- Nome da variável de ambiente com o segredo; nunca o segredo.
  secret_ref TEXT,
  model TEXT,
  concurrency INTEGER NOT NULL DEFAULT 1 CHECK (concurrency > 0),
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE model_capabilities (
  provider_profile_id TEXT NOT NULL REFERENCES provider_profiles (id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  capability TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('declared', 'tested', 'unknown', 'absent')),
  limits_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(limits_json)),
  contract_snapshot TEXT,
  verified_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY (provider_profile_id, operation, capability)
) STRICT;

CREATE TABLE recipe_revisions (
  id TEXT PRIMARY KEY,
  family TEXT NOT NULL,
  operation TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number > 0),
  required_fields_json TEXT NOT NULL CHECK (json_valid(required_fields_json)),
  template TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (family, operation, number)
) STRICT;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('generation', 'local_process', 'export', 'ingest')),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'needs_attention')),
  stage TEXT NOT NULL CHECK (stage IN ('prepare', 'submit', 'download', 'process', 'publish')),
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  current_attempt_id TEXT REFERENCES job_attempts (id) DEFERRABLE INITIALLY DEFERRED,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
  next_run_at TEXT NOT NULL,
  cancel_requested_at TEXT,
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (project_id, idempotency_key)
) STRICT;
CREATE INDEX jobs_ready ON jobs (state, next_run_at);
CREATE INDEX jobs_by_project ON jobs (project_id, created_at);

CREATE TABLE job_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  number INTEGER NOT NULL CHECK (number > 0),
  worker_id TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT CHECK (outcome IN ('succeeded', 'failed', 'cancelled', 'lease_expired', 'needs_attention', 'retry')),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  UNIQUE (job_id, number)
) STRICT;

CREATE TABLE job_parts (
  job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  part_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  remote_state TEXT NOT NULL CHECK (remote_state IN ('not_sent', 'sending', 'accepted', 'uncertain', 'completed', 'rejected')),
  remote_id TEXT,
  submit_count INTEGER NOT NULL DEFAULT 0 CHECK (submit_count >= 0),
  raw_blob_sha256 TEXT REFERENCES blobs (sha256),
  raw_mime TEXT,
  processed_json TEXT CHECK (processed_json IS NULL OR json_valid(processed_json)),
  cost_json TEXT CHECK (cost_json IS NULL OR json_valid(cost_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, part_key)
) STRICT;
CREATE INDEX job_parts_by_raw ON job_parts (raw_blob_sha256);

CREATE TABLE generation_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES job_attempts (id),
  provider_profile_id TEXT NOT NULL,
  profile_snapshot_json TEXT NOT NULL CHECK (json_valid(profile_snapshot_json)),
  recipe_revision_id TEXT NOT NULL,
  brief TEXT NOT NULL,
  prompt_sent TEXT NOT NULL,
  params_json TEXT NOT NULL CHECK (json_valid(params_json)),
  -- Custo com unidade; nulo = desconhecido (nunca convertido sem taxa documentada).
  cost_estimated_json TEXT CHECK (cost_estimated_json IS NULL OR json_valid(cost_estimated_json)),
  cost_actual_json TEXT CHECK (cost_actual_json IS NULL OR json_valid(cost_actual_json)),
  created_at TEXT NOT NULL,
  UNIQUE (attempt_id)
) STRICT;

CREATE TABLE run_inputs (
  run_id TEXT NOT NULL REFERENCES generation_runs (id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  revision_id TEXT NOT NULL,
  file_key TEXT,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  role TEXT NOT NULL,
  PRIMARY KEY (run_id, ordinal)
) STRICT;

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject', 'promote')),
  reason TEXT,
  technical_report_json TEXT CHECK (technical_report_json IS NULL OR json_valid(technical_report_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (revision_id, asset_id) REFERENCES asset_revisions (id, asset_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX reviews_by_asset ON reviews (asset_id, created_at);

CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  profile TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'failed')),
  job_id TEXT REFERENCES jobs (id),
  selection_json TEXT NOT NULL CHECK (json_valid(selection_json)),
  closure_json TEXT CHECK (closure_json IS NULL OR json_valid(closure_json)),
  zip_sha256 TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;

CREATE TABLE export_entries (
  export_id TEXT NOT NULL REFERENCES exports (id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES asset_revisions (id),
  PRIMARY KEY (export_id, revision_id)
) STRICT;

CREATE TABLE provider_asset_links (
  provider_profile_id TEXT NOT NULL,
  remote_asset_id TEXT NOT NULL,
  revision_id TEXT NOT NULL REFERENCES asset_revisions (id) ON DELETE CASCADE,
  remote_kind TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (provider_profile_id, remote_asset_id, revision_id)
) STRICT;

CREATE TABLE worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  current_job_id TEXT
) STRICT;
