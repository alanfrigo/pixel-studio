"use client";

import { useState } from "react";
import { apiFetch } from "@/app/client/api";
import { usePoll } from "@/app/client/use-poll";
import { MapsPanel } from "./maps-panel";
import { TexturesPanel } from "./textures-panel";
import { TilesetsPanel } from "./tilesets-panel";
import type { Profile, WorldCatalog } from "./world-client";

type Tab = "textures" | "tilesets" | "maps";
const TABS: [Tab, string][] = [
  ["textures", "Texturas repetíveis"],
  ["tilesets", "Tilesets"],
  ["maps", "Mapas"],
];

/**
 * Mundo (06): materiais com emenda validada, tilesets (cantos, lateral,
 * isométrico) com verificação e mapas editáveis com objetos, colisões,
 * regiões e portas. Cada rota identifica o que é geração, gabarito local ou importação.
 */
export function WorldStudio({ projectId, initialTab, initialMap }: { projectId: string; initialTab: Tab; initialMap: string | null }) {
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
      <h1>Mundo: texturas, tiles e mapas</h1>
      <div className="row" role="tablist" style={{ marginBottom: 12 }}>
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "" : "secondary"} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
        <button type="button" className="secondary" onClick={refresh}>
          Recarregar
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? (
        <p className="muted">Carregando…</p>
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
