"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ProjectView } from "@/server/catalog/catalog";
import { useLocale, useMessages } from "@/i18n/client";
import { studioMessages } from "@/i18n/messages/studio";
import { apiFetch } from "./client/api";
import { usePoll } from "./client/use-poll";

export function ProjectList({ templateId }: { templateId?: string }) {
  const locale = useLocale();
  const m = useMessages(studioMessages);
  const router = useRouter();
  const { data, error } = usePoll(() => apiFetch<{ projects: ProjectView[] }>("/projects"), { active: () => false, slowMs: 30_000 });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const templateQuery = templateId ? `?template=${encodeURIComponent(templateId)}#create` : "";

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setCreateError(null);
    try {
      const { project } = await apiFetch<{ project: ProjectView }>("/projects", { method: "POST", json: { name } });
      router.push(`/projects/${project.id}${templateQuery}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="studio-project-list">
      <form className="studio-new-project" onSubmit={create} aria-busy={busy}>
        <label htmlFor="new-project">{m.projectName}</label>
        <div>
          <input id="new-project" value={name} onChange={(e) => setName(e.target.value)} placeholder={m.projectPlaceholder} autoComplete="off" required maxLength={120} />
          <button className="btn btn--primary" disabled={busy}>{m.create}</button>
        </div>
        <p role="status" className={createError ? "error" : "muted"}>{createError || (busy ? m.creating : null)}</p>
      </form>
      <p className="studio-project-list-title" id="studio-project-list-label">{templateId ? m.chooseProject : m.recent}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {!data && !error && <p className="muted studio-list-state">{m.projectLoading}</p>}
      {data?.projects.length === 0 && <p className="muted studio-list-state">{m.empty}</p>}
      {data && data.projects.length > 0 && (
        <ul className="studio-project-rows" aria-labelledby="studio-project-list-label">
          {data.projects.map((p) => (
            <li key={p.id}>
              <Link href={`/projects/${p.id}${templateQuery}`}>
                <span className="studio-project-glyph" aria-hidden="true">▦</span>
                <strong>{p.name}</strong>
                <time dateTime={p.updatedAt}>{new Date(p.updatedAt).toLocaleDateString(locale)}</time>
                <span aria-hidden="true">↗</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
