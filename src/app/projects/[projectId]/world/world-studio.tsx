"use client";

import { useState } from "react";
import { apiFetch } from "@/app/client/api";
import { usePoll } from "@/app/client/use-poll";
import { useMessages } from "@/i18n/client";
import { commonMessages } from "@/i18n/messages/common";
import { worldMessages } from "@/i18n/messages/world";
import { MapsPanel } from "./maps-panel";
import { TexturesPanel } from "./textures-panel";
import { TilesetsPanel } from "./tilesets-panel";
import type { Profile, WorldCatalog } from "./world-client";

type Tab = "textures" | "tilesets" | "maps";
const TABS: Tab[] = ["textures", "tilesets", "maps"];

/**
 * Mundo (06): materiais com emenda validada, tilesets (cantos, lateral,
 * isométrico) com verificação e mapas editáveis com objetos, colisões,
 * regiões e portas. Cada rota identifica o que é geração, gabarito local ou importação.
 */
export function WorldStudio({ projectId, initialTab, initialMap }: { projectId: string; initialTab: Tab; initialMap: string | null }) {
  const m = useMessages(worldMessages).studio;
  const c = useMessages(commonMessages);
  const [tab, setTab] = useState<Tab>(initialTab);
  const { data, error, refresh } = usePoll(
    async () => {
      const [catalog, { profiles }] = await Promise.all([
        apiFetch<WorldCatalog>(`/projects/${projectId}/world`),
        apiFetch<{ profiles: Profile[] }>("/settings/providers"),
      ]);
      return { catalog, profiles };
    },
    { active: () => false, slowMs: 60_000 },
  );
  return (
    <>
      <h1>{m.title}</h1>
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
      ) : tab === "textures" ? (
        <TexturesPanel projectId={projectId} catalog={data.catalog} profiles={data.profiles} refresh={refresh} />
      ) : tab === "tilesets" ? (
        <TilesetsPanel projectId={projectId} catalog={data.catalog} profiles={data.profiles} refresh={refresh} />
      ) : (
        <MapsPanel projectId={projectId} catalog={data.catalog} refresh={refresh} initialMap={initialMap} />
      )}
    </>
  );
}
