"use client";

import { useState } from "react";
import { apiFetch } from "@/app/client/api";
import { usePoll } from "@/app/client/use-poll";
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
  if (!data) return <p className="muted">Carregando…</p>;
  const rig = data.rigs.find((r) => r.revisionId === rigId) ?? data.rigs.find((r) => data.loadouts.some((g) => g.revisions.some((x) => x.rigRevisionId === r.revisionId))) ?? data.rigs[0] ?? null;

  async function seed() {
    setSeeding(true);
    setMessage(null);
    try {
      await apiFetch(`/projects/${projectId}/equipment/demo`, { method: "POST" });
      setMessage("Demonstração do guerreiro semeada: base limpa em 4 vistas, ataques de 4 e 6 frames, cota, espada curta, escudo, espada longa e os conjuntos A e B aprovados. Nenhuma chamada a provedor.");
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setSeeding(false);
    }
  }

  return (
    <>
      <h1>Equipamentos e conjuntos</h1>
      <section>
        <div className="row">
          {data.rigs.length > 0 && rig && (
            <label>
              Base / rig
              <select value={rig.revisionId} onChange={(e) => setRigId(e.target.value)}>
                {data.rigs.map((r) => (
                  <option key={r.revisionId} value={r.revisionId}>
                    {r.base?.name ?? "base"} · {r.name} r{r.number}
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
                  <img key={v.direction} className="pixel" alt={`Vista ${v.direction}`} title={`Vista ${v.direction}`} src={mediaUrl(projectId, v.mediaId)} width={48} height={48} />
                ) : null,
              )}
            </span>
          )}
          {rig && (
            <span className="small muted">
              célula {rig.cell.join("×")} · slots {rig.slots.map((s) => s.slotId).join(", ")} · sockets {rig.sockets.map((s) => s.socketId).join(", ")} · posturas {rig.stances.join(", ")} · tolerância {rig.tolerancePx} px
            </span>
          )}
          {!data.demo.seeded && (
            <button type="button" className="secondary" disabled={seeding} onClick={seed}>
              {seeding ? "Semeando…" : "Semear demonstração do guerreiro"}
            </button>
          )}
        </div>
        {message && <p className="small">{message}</p>}
        {!rig && <p className="small">Nenhum rig de equipamento aprovado neste projeto. Semeie a demonstração ou importe/aprove um rig (character/rig) com slots, sockets e partes.</p>}
      </section>
      {rig && (
        <>
          <nav className="row anim-tabs">
            {(
              [
                ["loadouts", "Conjuntos"],
                ["pieces", "Peças"],
                ["create", "Criar peça"],
              ] as const
            ).map(([t, label]) => (
              <button key={t} type="button" className={tab === t ? "" : "secondary"} onClick={() => setTab(t)}>
                {label}
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
