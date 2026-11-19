-- Exportação (cartão X1): nome do arquivo, tamanho e chave de idempotência da seleção.
ALTER TABLE exports ADD COLUMN file_name TEXT;
ALTER TABLE exports ADD COLUMN bytes INTEGER CHECK (bytes IS NULL OR bytes > 0);
CREATE INDEX exports_by_project ON exports (project_id, created_at);
CREATE UNIQUE INDEX exports_by_job ON exports (job_id);
