-- Etiquetas da biblioteca (cartão S3): organizam assets sem tocar revisões.
-- Etiquetar ou remover etiqueta nunca cria revisão nem altera pacotes exportados.
CREATE TABLE asset_tags (
  asset_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  tag TEXT NOT NULL CHECK (length(tag) BETWEEN 1 AND 48),
  created_at TEXT NOT NULL,
  PRIMARY KEY (asset_id, tag),
  FOREIGN KEY (asset_id, project_id) REFERENCES assets (id, project_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX asset_tags_by_project_tag ON asset_tags (project_id, tag);
