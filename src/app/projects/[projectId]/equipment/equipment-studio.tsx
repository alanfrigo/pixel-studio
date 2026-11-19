"use client";

import { useState } from "react";
import { apiFetch } from "@/app/client/api";
import { usePoll } from "@/app/client/use-poll";
import { useLocale, useMessages } from "@/i18n/client";
import { commonMessages } from "@/i18n/messages/common";
import { equipmentMessages } from "@/i18n/messages/equipment";
import { CreatePiece } from "./create-piece";
import { type CoveragePrefill, LoadoutWorkspace } from "./loadout-workspace";
import { PiecesPanel } from "./pieces-panel";
import { errorText, mediaUrl, type Overview } from "./shared";

/**
 * Equipamentos e conjuntos (cartão S2): base/rig, conjuntos com troca de
 * itens e conflitos explicados, player do clipe resolvido, matriz de
 * cobertura, peças e "Criar peça para este personagem". Só "Gerar" fala com
 * provedor; o resto é local.
 */

type Tab = "loadouts" | "pieces" | "create";

export function EquipmentStudio({ projectId }: { projectId: string }) {
  const locale = useLocale();
  const c = useMessages(commonMessages);
  const m = useMessages(equipmentMessages).studio;
  const { data, error, refresh } = usePoll(() => apiFetch<Overview>(`/projects/${projectId}/equipment`), {
    active: (d) => d.jobs.some((j) => j.state === "queued" || j.state === "running"),
    fastMs: 1500,
    slowMs: 20_000,
  });
  const [rigId, setRigId] = useState("");
  const [tab, setTab] = useState<Tab>("loadouts");
  const [prefill, setPrefill] = useState<{ n: number; value: CoveragePrefill } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);

  if (error && !data) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">{c.loading}</p>;
  const rig = data.rigs.find((r) => r.revisionId === rigId) ?? data.rigs.find((r) => data.loadouts.some((g) => g.revisions.some((x) => x.rigRevisionId === r.revisionId))) ?? data.rigs[0] ?? null;

  async function seed() {
    setSeeding(true);
    setMessage(null);
    try {
      await apiFetch(`/projects/${projectId}/equipment/demo`, { method: "POST" });
      setMessage(m.seeded);
      refresh();
    } catch (err) {
      setMessage(errorText(err, locale));
    } finally {
      setSeeding(false);
    }
  }

  return (
    <>
      <h1>{m.title}</h1>
      <section>
        <div className="row">
          {data.rigs.length > 0 && rig && (
            <label>
              {m.rig}
              <select value={rig.revisionId} onChange={(e) => setRigId(e.target.value)}>
                {data.rigs.map((r) => (
                  <option key={r.revisionId} value={r.revisionId}>
                    {r.base?.name ?? m.baseFallback} · {r.name} r{r.number}
                  </option>
                ))}
              </select>
            </label>
          )}
          {rig?.base && (
            <span className="row small">
              {rig.base.views.map((v) =>
                v.mediaId ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={v.direction} className="pixel" alt={m.view(v.direction)} title={m.view(v.direction)} src={mediaUrl(projectId, v.mediaId)} width={48} height={48} />
                ) : null,
              )}
            </span>
          )}
          {rig && (
            <span className="small muted">
              {m.rigInfo(
                rig.cell.join("×"),
                rig.slots.map((s) => s.slotId).join(", "),
                rig.sockets.map((s) => s.socketId).join(", "),
                rig.stances.join(", "),
                rig.tolerancePx,
              )}
            </span>
          )}
        </div>
        {message && <p className="small">{message}</p>}
        {!rig && <p className="small">{m.noRig}</p>}
        {!data.demo.seeded && (
          <details className="workspace-demo">
            <summary>{m.demo}</summary>
            <p className="muted">{m.demoHint}</p>
            <button type="button" className="secondary" disabled={seeding} onClick={seed}>
              {seeding ? m.seeding : m.seed}
            </button>
          </details>
        )}
      </section>
      {rig && (
        <>
          <nav className="row anim-tabs">
            {(["loadouts", "pieces", "create"] as const).map((t) => (
              <button key={t} type="button" className={tab === t ? "" : "secondary"} onClick={() => setTab(t)}>
                {m.tabs[t]}
              </button>
            ))}
          </nav>
          {tab === "loadouts" && (
            <LoadoutWorkspace
              key={rig.revisionId}
              projectId={projectId}
              overview={data}
              rig={rig}
              refresh={refresh}
              onCreateCoverage={(p) => {
                setPrefill((cur) => ({ n: (cur?.n ?? 0) + 1, value: p }));
                setTab("create");
              }}
            />
          )}
          {tab === "pieces" && <PiecesPanel projectId={projectId} overview={data} rig={rig} refresh={refresh} />}
          {tab === "create" && <CreatePiece key={`${rig.revisionId}-${prefill?.n ?? 0}`} projectId={projectId} overview={data} rig={rig} prefill={prefill?.value ?? null} refresh={refresh} />}
        </>
      )}
    </>
  );
}
