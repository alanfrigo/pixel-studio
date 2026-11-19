"use client";

import { apiFetch, formatBytes, type Health } from "./api";
import { usePoll } from "./use-poll";

/** Avisa quando o worker ou o Python estão indisponíveis; revisar assets prontos continua possível. */
export function HealthBanner() {
  const { data, error } = usePoll(() => apiFetch<Health>("/health"), { active: () => false, fastMs: 5000, slowMs: 10_000 });
  if (error) return <div className="banner banner-error">Servidor indisponível: {error}</div>;
  if (!data) return null;
  const problems: string[] = [];
  if (!data.worker.online) problems.push("Worker indisponível: gerações e importações ficam na fila até ele voltar (npm run dev inicia os dois).");
  if (!data.python.ok) problems.push(`Processador Python indisponível: ${data.python.error ?? "erro desconhecido"}`);
  return (
    <div className={problems.length ? "banner banner-warn" : "banner banner-ok"}>
      {problems.length ? (
        problems.map((p) => <div key={p}>{p}</div>)
      ) : (
        <span>
          Worker ativo · Python {data.python.python} / Pillow {data.python.pillow} · SQLite {data.sqlite.version} · {formatBytes(data.storage.freeBytes)} livres
        </span>
      )}
    </div>
  );
}
