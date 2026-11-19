"use client";

import Link from "next/link";
import { useState } from "react";
import type { ProjectView } from "@/server/catalog/catalog";
import { apiFetch } from "./client/api";
import { usePoll } from "./client/use-poll";

export function ProjectList() {
  const { data, error, refresh } = usePoll(() => apiFetch<{ projects: ProjectView[] }>("/projects"), { active: () => false, slowMs: 30_000 });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setCreateError(null);
    try {
      await apiFetch("/projects", { method: "POST", json: { name } });
      setName("");
      refresh();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Projetos</h2>
      <form onSubmit={create}>
        <label>
          Nome do jogo
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Clareira" required maxLength={120} />
        </label>
        <button disabled={busy || !name.trim()}>Criar projeto</button>
        {createError && <span className="error">{createError}</span>}
      </form>
      {error && <p className="error">{error}</p>}
      <ul className="list" style={{ marginTop: 12 }}>
        {data?.projects.length === 0 && <li className="muted">Nenhum projeto ainda. Comece por texto puro: crie um projeto e gere o primeiro asset.</li>}
        {data?.projects.map((p) => (
          <li key={p.id}>
            <Link href={`/projects/${p.id}`}>{p.name}</Link> <span className="muted small">· atualizado {new Date(p.updatedAt).toLocaleString("pt-BR")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
