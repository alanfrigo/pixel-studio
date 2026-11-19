-- Cache de processamento local (cartão P1; plan/05 §repetição e recuperação).
-- A chave cobre operação, receita canônica, entradas ordenadas (papel + hash)
-- e versões do processador: mesma chave → mesmos bytes, sem reprocessar.
CREATE TABLE process_results (
  cache_key TEXT PRIMARY KEY CHECK (length(cache_key) = 64),
  operation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'needs_review')),
  outputs_json TEXT NOT NULL CHECK (json_valid(outputs_json)),
  report_json TEXT NOT NULL CHECK (json_valid(report_json)),
  warnings_json TEXT NOT NULL CHECK (json_valid(warnings_json)),
  processor_json TEXT NOT NULL CHECK (json_valid(processor_json)),
  created_at TEXT NOT NULL
) STRICT;
