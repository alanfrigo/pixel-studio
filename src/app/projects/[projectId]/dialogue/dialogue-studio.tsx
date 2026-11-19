"use client";

import { useState } from "react";
import { apiFetch } from "@/app/client/api";
import { usePoll } from "@/app/client/use-poll";
import { useMessages } from "@/i18n/client";
import { commonMessages } from "@/i18n/messages/common";
import { dialogueMessages } from "@/i18n/messages/dialogue";
import type { DialogueCatalog, Profile } from "./dialogue-client";
import { ExpressionsPanel } from "./expressions-panel";
import { FontPanel } from "./font-panel";
import { PortraitPanel } from "./portrait-panel";
import { SpeechPanel } from "./speech-panel";

export type DialogueTab = "portrait" | "expressions" | "speech" | "font";
const TABS: DialogueTab[] = ["portrait", "expressions", "speech", "font"];

/**
 * Bancada de diálogo e tipografia (cartão D1 · 07 §tipografia e retratos):
 * retrato ligado ao personagem, expressões com bocas lado a lado, planejador
 * de fala com prévia e fonte bitmap com cobertura e texto de teste. Tudo
 * publica revisões candidatas aprovadas pelo fluxo existente.
 */
export function DialogueStudio({ projectId, initialTab }: { projectId: string; initialTab: DialogueTab }) {
  const m = useMessages(dialogueMessages);
  const c = useMessages(commonMessages);
  const [tab, setTab] = useState<DialogueTab>(initialTab);
  const { data, error, refresh } = usePoll(
    async () => {
      const [catalog, { profiles }] = await Promise.all([apiFetch<DialogueCatalog>(`/projects/${projectId}/dialogue`), apiFetch<{ profiles: Profile[] }>("/settings/providers")]);
      return { catalog, profiles };
    },
    { active: () => false, slowMs: 60_000 },
  );
  return (
    <>
      <h1>{m.title}</h1>
      <p className="small muted">{m.intro}</p>
      <div className="row" role="tablist" style={{ marginBottom: 12 }}>
        {TABS.map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "" : "secondary"} onClick={() => setTab(id)}>
            {m.tabs[id]}
          </button>
        ))}
        <button type="button" className="secondary" onClick={refresh}>
          {m.reload}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? (
        <p className="muted">{c.loading}</p>
      ) : tab === "portrait" ? (
        <PortraitPanel projectId={projectId} catalog={data.catalog} profiles={data.profiles} refresh={refresh} />
      ) : tab === "expressions" ? (
        <ExpressionsPanel projectId={projectId} catalog={data.catalog} profiles={data.profiles} refresh={refresh} />
      ) : tab === "speech" ? (
        <SpeechPanel projectId={projectId} catalog={data.catalog} refresh={refresh} />
      ) : (
        <FontPanel projectId={projectId} catalog={data.catalog} profiles={data.profiles} refresh={refresh} />
      )}
    </>
  );
}
