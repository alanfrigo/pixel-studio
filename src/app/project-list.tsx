"use client";

import Link from "next/link";
import { useState } from "react";
import type { ProjectView } from "@/server/catalog/catalog";
import { useLocale, useMessages } from "@/i18n/client";
import { homeMessages } from "@/i18n/messages/home";
import { apiFetch } from "./client/api";
import { usePoll } from "./client/use-poll";

export function ProjectList() {
  const locale = useLocale();
  const m = useMessages(homeMessages).projects;
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
      <h2>{m.title}</h2>
      <form onSubmit={create}>
        <label>
          {m.gameName}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={m.namePlaceholder} required maxLength={120} />
        </label>
        <button disabled={busy || !name.trim()}>{m.create}</button>
        {createError && <span className="error">{createError}</span>}
      </form>
      {error && <p className="error">{error}</p>}
      <ul className="list" style={{ marginTop: 12 }}>
        {data?.projects.length === 0 && <li className="muted">{m.empty}</li>}
        {data?.projects.map((p) => (
          <li key={p.id}>
            <Link href={`/projects/${p.id}`}>{p.name}</Link> <span className="muted small">· {m.updated(new Date(p.updatedAt).toLocaleString(locale))}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
