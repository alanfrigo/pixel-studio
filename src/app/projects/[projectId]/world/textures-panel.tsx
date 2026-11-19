"use client";

import Link from "next/link";
import { useState } from "react";
import type { TexturePayload } from "@/contracts";
import type { AssetView, RevisionView } from "@/server/catalog/catalog";
import { apiFetch } from "@/app/client/api";
import { JobStatus } from "./job-status";
import { errorText, estimateLabel, fileOf, mediaUrl, PIXEL, type PlanPreview, type Profile, review, runPlan, uploadImage, type WorldCatalog } from "./world-client";

/**
 * Textura repetível própria (06 §repetição verificável): gerar material,
 * importar, abrir a bancada (mosaico 3×3 em 1× e ampliado, linhas de emenda,
 * deslocamento cíclico) e corrigir emendas por inpainting.
 */

interface SeamAxis {
  seamDelta: number;
  interiorDelta: number;
  ratio: number;
  passed: boolean;
  flagged: { start: number; end: number; maxDelta: number }[];
}
interface SeamReport {
  threshold: number;
  x: SeamAxis | null;
  y: SeamAxis | null;
}

function axisBadge(payload: TexturePayload, axis: "x" | "y") {
  const requested = payload.requestedAxes?.[axis] ?? payload.repeatAxes[axis];
  if (!requested) return <span className="badge">{axis.toUpperCase()}: não pedido</span>;
  return payload.repeatAxes[axis] ? (
    <span className="badge state-approved">{axis.toUpperCase()}: repetível</span>
  ) : (
    <span className="badge state-rejected">{axis.toUpperCase()}: emenda reprovada</span>
  );
}

export function TexturesPanel({ projectId, catalog, profiles, refresh }: { projectId: string; catalog: WorldCatalog; profiles: Profile[]; refresh: () => void }) {
  const [bench, setBench] = useState<{ asset: AssetView; revision: RevisionView } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const textures = catalog.textures;

  async function decide(asset: AssetView, revision: RevisionView, decision: "approve" | "reject") {
    try {
      const reason = decision === "reject" ? (window.prompt("Motivo da reprovação") ?? "").trim() || null : null;
      if (decision === "reject" && !reason) return;
      await review(projectId, asset, revision.id, decision, reason);
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  return (
    <>
      {message && <p className="error">{message}</p>}
      <div className="grid2">
        <GenerateTexture projectId={projectId} profiles={profiles} textures={textures} refresh={refresh} />
        <ImportTexture projectId={projectId} refresh={refresh} />
      </div>
      <section>
        <h2>Texturas do projeto</h2>
        {textures.length === 0 && <p className="muted small">Nenhuma textura ainda. Gere um material ou importe uma imagem.</p>}
        {textures.map(({ asset, revisions }) => (
          <div key={asset.id} style={{ marginBottom: 12 }}>
            <strong>{asset.name}</strong>{" "}
            <span className="muted small">
              {asset.approvedRevisionId ? `ativa r${revisions.find((r) => r.id === asset.approvedRevisionId)?.number}` : "sem revisão aprovada"}
            </span>
            <div className="row" style={{ alignItems: "flex-start", marginTop: 6 }}>
              {revisions.slice(0, 6).map((rev) => {
                const payload = rev.payload as TexturePayload;
                const tex = fileOf(rev, "texture");
                const report = rev.technicalReport as { verdict?: string; routeLabel?: string; label?: string } | null;
                return (
                  <div key={rev.id} className="small" style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8, width: 230 }}>
                    <div className="row">
                      {tex && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={mediaUrl(projectId, tex.id)} alt={`${asset.name} r${rev.number}`} width={payload.logicalSize[0] * 2} height={payload.logicalSize[1] * 2} className="pixel bg-checker" style={PIXEL} />
                      )}
                      <div>
                        r{rev.number} <span className={`badge state-${rev.status}`}>{rev.status}</span>
                        <br />
                        {payload.logicalSize.join("×")} · {rev.origin}
                      </div>
                    </div>
                    <div className="row" style={{ marginTop: 4 }}>
                      {axisBadge(payload, "x")}
                      {axisBadge(payload, "y")}
                    </div>
                    {report?.verdict && <p className="muted">{report.verdict}</p>}
                    <div className="row">
                      <button type="button" className="secondary" onClick={() => setBench({ asset, revision: rev })}>
                        Bancada
                      </button>
                      {rev.status === "candidate" && (
                        <>
                          <button type="button" onClick={() => decide(asset, rev, "approve")}>
                            Aprovar
                          </button>
                          <button type="button" className="secondary" onClick={() => decide(asset, rev, "reject")}>
                            Reprovar
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </section>
      {bench && <TextureBench projectId={projectId} asset={bench.asset} revision={bench.revision} refresh={refresh} onClose={() => setBench(null)} />}
    </>
  );
}

function TextureBench({ projectId, asset, revision, refresh, onClose }: { projectId: string; asset: AssetView; revision: RevisionView; refresh: () => void; onClose: () => void }) {
  const [lines, setLines] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const payload = revision.payload as TexturePayload;
  const report = (revision.technicalReport as { seams?: SeamReport } | null)?.seams ?? null;
  const axes = payload.requestedAxes ?? payload.repeatAxes;
  const url = (key: string) => {
    const f = fileOf(revision, key);
    return f ? mediaUrl(projectId, f.id) : null;
  };
  const [w, h] = payload.logicalSize;
  const cols = axes.x ? 3 : 1;
  const rows = axes.y ? 3 : 1;
  const zoom = Math.max(1, Math.floor(384 / Math.max(w * cols, h * rows)));

  async function publish(image: { from: "revision"; revisionId: string; fileKey: string }, unshift: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiFetch<{ revision: RevisionView; verdict: string }>(`/projects/${projectId}/world/textures`, {
        method: "POST",
        json: { target: { assetId: asset.id }, texture: { image, material: payload.material, axes, threshold: payload.seamReport.threshold, sourceRevisionId: revision.id, unshift } },
      });
      setMessage(`r${res.revision.number} publicada como candidata · ${res.verdict}`);
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>
          Bancada de repetição · {asset.name} r{revision.number}
        </h2>
        <button type="button" className="secondary" onClick={onClose}>
          Fechar
        </button>
      </div>
      <p className="small">
        Material: {payload.material} · limiar declarado {payload.seamReport.threshold} (emenda/interior) · método {payload.seamReport.method}
      </p>
      {report && (
        <table className="small" style={{ marginBottom: 8 }}>
          <thead>
            <tr>
              <th>Eixo</th>
              <th>Emenda</th>
              <th>Interior</th>
              <th>Razão</th>
              <th>Resultado</th>
              <th>Costuras destacadas</th>
            </tr>
          </thead>
          <tbody>
            {(["x", "y"] as const).map((a) =>
              report[a] ? (
                <tr key={a}>
                  <td>{a.toUpperCase()}</td>
                  <td>{report[a]!.seamDelta}</td>
                  <td>{report[a]!.interiorDelta}</td>
                  <td>{report[a]!.ratio}</td>
                  <td className={report[a]!.passed ? "" : "error"}>{report[a]!.passed ? "aprovada" : "reprovada"}</td>
                  <td>{report[a]!.flagged.map((f) => `${a === "x" ? "linhas" : "colunas"} ${f.start}–${f.end} (Δ ${f.maxDelta})`).join("; ") || "—"}</td>
                </tr>
              ) : (
                <tr key={a}>
                  <td>{a.toUpperCase()}</td>
                  <td colSpan={5} className="muted">
                    Não pedido: a repetição num eixo não promete o outro.
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
      <div className="row" style={{ alignItems: "flex-start" }}>
        <figure style={{ margin: 0 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {url("mosaic") && <img src={url("mosaic")!} alt="Mosaico 1×" className="pixel bg-checker" style={PIXEL} />}
          <figcaption className="small">
            Mosaico {cols}×{rows} em 1×
          </figcaption>
        </figure>
        <figure style={{ margin: 0 }}>
          {lines && url("mosaic-lines") ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url("mosaic-lines")!} alt="Mosaico ampliado com emendas" style={{ ...PIXEL, width: w * cols * zoom }} />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            url("mosaic") && <img src={url("mosaic")!} alt="Mosaico ampliado" className="pixel" style={{ ...PIXEL, width: w * cols * zoom }} />
          )}
          <figcaption className="small">
            <label style={{ flexDirection: "row", gap: 4, color: "inherit" }}>
              <input type="checkbox" checked={lines} onChange={(e) => setLines(e.target.checked)} /> linhas de emenda (magenta = costura discrepante)
            </label>
          </figcaption>
        </figure>
        <figure style={{ margin: 0 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {url("shifted") && <img src={url("shifted")!} alt="Deslocada" className="pixel" style={{ ...PIXEL, width: w * 4 }} />}
          <figcaption className="small">Deslocamento cíclico de meio período: as emendas no centro</figcaption>
        </figure>
      </div>
      <ScrollPreview src={url("texture")} size={[w, h]} axes={axes} />
      <h3 className="small">Corrigir emendas</h3>
      <ol className="small">
        <li>
          <button type="button" className="secondary" disabled={busy || !url("shifted")} onClick={() => publish({ from: "revision", revisionId: revision.id, fileKey: "shifted" }, false)}>
            Publicar a versão deslocada
          </button>{" "}
          (as emendas vão para o centro; aprove-a como amostra).
        </li>
        <li>
          Pintar as emendas e reconstruí-las por{" "}
          {revision.status === "approved" ? (
            <Link href={`/projects/${projectId}/inpaint?asset=${asset.id}&revision=${revision.id}&file=texture`}>inpainting desta revisão</Link>
          ) : (
            "inpainting (abra a revisão deslocada aprovada)"
          )}
          .
        </li>
        <li>
          <button type="button" className="secondary" disabled={busy} onClick={() => publish({ from: "revision", revisionId: revision.id, fileKey: "texture" }, true)}>
            Desfazer o deslocamento desta revisão e revalidar
          </button>
        </li>
      </ol>
      {message && <p className="small">{message}</p>}
    </section>
  );
}

/** Rolagem nos eixos declarados: a mesma textura repetida num fundo que se desloca. */
function ScrollPreview({ src, size, axes }: { src: string | null; size: [number, number]; axes: { x: boolean; y: boolean } }) {
  const [offset, setOffset] = useState(0);
  if (!src) return null;
  const scale = 3;
  return (
    <div className="small" style={{ marginTop: 8 }}>
      <div
        className="pixel"
        style={{
          ...PIXEL,
          width: 360,
          height: axes.y ? 180 : size[1] * scale,
          backgroundImage: `url(${src})`,
          backgroundSize: `${size[0] * scale}px ${size[1] * scale}px`,
          backgroundRepeat: axes.x && axes.y ? "repeat" : axes.x ? "repeat-x" : "repeat-y",
          backgroundPosition: `${axes.x ? -offset : 0}px ${axes.y ? -offset : 0}px`,
          border: "1px solid var(--border)",
        }}
      />
      <label style={{ flexDirection: "row", gap: 6, color: "inherit" }}>
        Rolagem
        <input type="range" min={0} max={size[0] * scale * 4} value={offset} onChange={(e) => setOffset(Number(e.target.value))} />
      </label>
    </div>
  );
}

function GenerateTexture({ projectId, profiles, textures, refresh }: { projectId: string; profiles: Profile[]; textures: WorldCatalog["textures"]; refresh: () => void }) {
  const usable = profiles.filter((p) => (p.capabilities.generate_texture?.length ?? 0) > 0);
  const [name, setName] = useState("Pedra úmida");
  const [brief, setBrief] = useState("pedra úmida com musgo entre as juntas");
  const [size, setSize] = useState(32);
  const [axes, setAxes] = useState({ x: true, y: true });
  const [threshold, setThreshold] = useState(1.5);
  const [refs, setRefs] = useState<string[]>([]);
  const [profileId, setProfileId] = useState("");
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const profile = usable.find((p) => p.id === profileId) ?? usable[0];
  const approved = textures.flatMap(({ asset, revisions }) => revisions.filter((r) => r.status === "approved").map((r) => ({ asset, r })));

  async function plan() {
    setMessage(null);
    try {
      if (!profile) throw new Error("Nenhum perfil gera material");
      const p = await apiFetch<PlanPreview>(`/projects/${projectId}/generation-plans`, {
        method: "POST",
        json: { operation: "generate_texture", providerProfileId: profile.id, materialBrief: brief, logicalSize: [size, size], repeatAxes: axes, seamThreshold: threshold, referenceRevisionIds: refs },
      });
      setPreview(p);
      return p;
    } catch (err) {
      setMessage(errorText(err));
      return null;
    }
  }

  async function run() {
    const p = preview ?? (await plan());
    if (!p) return;
    try {
      const { asset } = await apiFetch<{ asset: AssetView }>(`/projects/${projectId}/assets`, { method: "POST", json: { family: "texture", kind: "material", name } });
      const res = await runPlan(projectId, p, asset.id);
      setJobId(res.job.id);
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  return (
    <section>
      <h2>Gerar material</h2>
      <div className="row">
        <label>
          Nome
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Tamanho
          <select value={size} onChange={(e) => (setSize(Number(e.target.value)), setPreview(null))}>
            {[16, 32, 48, 64].map((s) => (
              <option key={s} value={s}>
                {s}×{s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Limiar
          <input type="number" step={0.1} min={1} max={5} value={threshold} onChange={(e) => (setThreshold(Number(e.target.value)), setPreview(null))} style={{ width: 70 }} />
        </label>
        {(["x", "y"] as const).map((a) => (
          <label key={a} style={{ flexDirection: "row", gap: 4, color: "inherit" }}>
            <input type="checkbox" checked={axes[a]} onChange={(e) => (setAxes({ ...axes, [a]: e.target.checked }), setPreview(null))} /> repete em {a.toUpperCase()}
          </label>
        ))}
      </div>
      <label>
        Material
        <textarea value={brief} maxLength={500} onChange={(e) => (setBrief(e.target.value), setPreview(null))} />
      </label>
      {approved.length > 0 && (
        <label>
          Referências de material (aprovadas)
          <select multiple value={refs} onChange={(e) => (setRefs([...e.target.selectedOptions].map((o) => o.value)), setPreview(null))}>
            {approved.map(({ asset, r }) => (
              <option key={r.id} value={r.id}>
                {asset.name} r{r.number}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <label>
          Perfil
          <select value={profile?.id ?? ""} onChange={(e) => (setProfileId(e.target.value), setPreview(null))}>
            {usable.length === 0 && <option value="">Nenhum perfil gera material</option>}
            {usable.map((p) => (
              <option key={p.id} value={p.id} disabled={Boolean(p.unavailable)}>
                {p.name}
                {p.unavailable ? " (indisponível)" : ""}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="secondary" disabled={!axes.x && !axes.y} onClick={plan}>
          Prévia do plano
        </button>
        <button type="button" disabled={!axes.x && !axes.y} onClick={run}>
          Gerar
        </button>
      </div>
      {preview && (
        <div className="small">
          <p>
            {preview.routeLabel} · destino {preview.destination.name}
            {preview.destination.simulated ? " (simulado)" : ""} · estimativa {estimateLabel(preview.plan)}
          </p>
          <pre style={{ whiteSpace: "pre-wrap" }}>{preview.plan.prompt.compiled}</pre>
        </div>
      )}
      {message && <p className="error small">{message}</p>}
      {jobId && <JobStatus projectId={projectId} jobId={jobId} onDone={refresh} />}
    </section>
  );
}

function ImportTexture({ projectId, refresh }: { projectId: string; refresh: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [axes, setAxes] = useState({ x: true, y: true });
  const [threshold, setThreshold] = useState(1.5);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit() {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const uploadId = await uploadImage(projectId, file, file.name);
      const material = name.trim() || file.name.replace(/\.[^.]+$/, "");
      const res = await apiFetch<{ revision: RevisionView; verdict: string }>(`/projects/${projectId}/world/textures`, {
        method: "POST",
        json: { target: { name: material }, texture: { image: { from: "upload", uploadId }, material, axes, threshold } },
      });
      setMessage(`r${res.revision.number}: ${res.verdict}`);
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Importar textura</h2>
      <p className="small muted">Importação é alternativa rotulada: não demonstra geração. A emenda é validada do mesmo jeito.</p>
      <div className="row">
        <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <label>
          Material
          <input value={name} placeholder="nome do arquivo" onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Limiar
          <input type="number" step={0.1} min={1} max={5} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} style={{ width: 70 }} />
        </label>
        {(["x", "y"] as const).map((a) => (
          <label key={a} style={{ flexDirection: "row", gap: 4, color: "inherit" }}>
            <input type="checkbox" checked={axes[a]} onChange={(e) => setAxes({ ...axes, [a]: e.target.checked })} /> {a.toUpperCase()}
          </label>
        ))}
        <button type="button" disabled={busy || !file || (!axes.x && !axes.y)} onClick={submit}>
          Importar e validar
        </button>
      </div>
      {message && <p className="small">{message}</p>}
    </section>
  );
}
