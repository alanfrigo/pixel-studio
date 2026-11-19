"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { GenerationPlan } from "@/contracts";
import type { AssetView, RevisionView, UploadView } from "@/server/catalog/catalog";
import type { JobView } from "@/server/jobs/queue";
import type { ProviderProfileView } from "@/server/providers/registry";
import { ApiError, apiFetch } from "@/app/client/api";
import { estimateText } from "@/app/client/cost";
import { usePoll } from "@/app/client/use-poll";
import { type PreviewBg, RevisionCompare } from "../revision-compare";

/**
 * Inpainting (05 §inpainting, cartão E1): pintar a região, escrever o que deve
 * existir ali, conferir o plano (modo, alcance, custo) e comparar fonte,
 * candidato e resultado protegido. Fora da máscara, nenhum byte muda.
 */

type Mode = "native-mask" | "candidate-composite";
const MODE_LABEL: Record<Mode, string> = {
  "native-mask": "Inpainting com máscara nativa",
  "candidate-composite": "Candidato editado + recorte local (sem condicionamento nativo por máscara)",
};
const OVERLAY: [number, number, number, number] = [255, 0, 200, 110];

interface PlanPreview {
  plan: GenerationPlan;
  digest: string;
  destination: { name: string; simulated: boolean };
  mask: { editedPixels: number; protectedPixels: number; fullMask: boolean; editRect: number[] | null };
  modeLabel: string;
  scope: string;
}

type Profile = ProviderProfileView & { capabilities: Record<string, string[]>; unavailable: string | null };

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** PNG preto/branco opaco: 255 edita, 0 protege (convenção interna, sem cinza nem alfa). */
async function maskPng(mask: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const data = new ImageData(w, h);
  for (let i = 0; i < mask.length; i++) data.data.set([mask[i]!, mask[i]!, mask[i]!, 255], i * 4);
  canvas.getContext("2d")!.putImageData(data, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Falha ao gerar PNG"))), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

export function InpaintEditor({ projectId, assetId, revisionId, fileKey }: { projectId: string; assetId: string; revisionId: string; fileKey: string }) {
  const base = `/projects/${projectId}`;
  const { data } = usePoll(
    async () => {
      const [{ asset, revisions }, { profiles }] = await Promise.all([
        apiFetch<{ asset: AssetView; revisions: RevisionView[] }>(`${base}/assets/${assetId}`),
        apiFetch<{ profiles: Profile[] }>("/settings/providers"),
      ]);
      return { asset, revisions, profiles: profiles.filter((p) => (p.capabilities.inpaint?.length ?? 0) > 0) };
    },
    { active: () => false, slowMs: 60_000 },
  );
  const source = data?.revisions.find((r) => r.id === revisionId) ?? null;
  const file = source?.files.find((f) => f.fileKey === fileKey) ?? null;
  const w = Number(file?.metadata.width ?? 0);
  const h = Number(file?.metadata.height ?? 0);
  const src = file ? `/api/v1/projects/${projectId}/media/${file.id}` : null;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskRef = useRef<Uint8Array | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const lastRef = useRef<[number, number] | null>(null);
  const [version, setVersion] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [brush, setBrush] = useState(4);
  const [tool, setTool] = useState<"paint" | "erase">("paint");
  const [showOverlay, setShowOverlay] = useState(true);
  const [instruction, setInstruction] = useState("");
  const [profileId, setProfileId] = useState("");
  const [mode, setMode] = useState<Mode | "">("");
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const uploaded = useRef<{ digest: string; uploadId: string } | null>(null);
  const zoom = w && h ? Math.max(1, Math.floor(512 / Math.max(w, h))) : 1;

  const profile = data?.profiles.find((p) => p.id === (profileId || data.profiles[0]?.id)) ?? null;
  const caps = profile?.capabilities.inpaint ?? [];
  const effectiveMode: Mode | null = mode || (caps.includes("native_mask") ? "native-mask" : caps.includes("image_edit") ? "candidate-composite" : null);

  // Carrega a fonte e cria a máscara vazia na mesma grade.
  useEffect(() => {
    if (!src || !w || !h) return;
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      maskRef.current = new Uint8Array(w * h);
      setLoaded(true);
    };
    img.src = src;
  }, [src, w, h]);

  // Redesenha fonte + sobreposição da máscara em zoom inteiro.
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    const mask = maskRef.current;
    if (!canvas || !img || !mask || !loaded) return;
    canvas.width = w * zoom;
    canvas.height = h * zoom;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    if (!showOverlay) return;
    const overlay = new ImageData(w, h);
    for (let i = 0; i < mask.length; i++) if (mask[i]) overlay.data.set(OVERLAY, i * 4);
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    off.getContext("2d")!.putImageData(overlay, 0, 0);
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
  }, [loaded, version, showOverlay, w, h, zoom]);

  const touch = () => {
    setVersion((v) => v + 1);
    setPreview(null);
  };

  function stamp(x: number, y: number) {
    const mask = maskRef.current!;
    const half = Math.floor((brush - 1) / 2);
    for (let j = y - half; j < y - half + brush; j++) {
      for (let i = x - half; i < x - half + brush; i++) {
        if (i >= 0 && j >= 0 && i < w && j < h) mask[j * w + i] = tool === "paint" ? 255 : 0;
      }
    }
  }

  function paintTo(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / zoom);
    const y = Math.floor((e.clientY - rect.top) / zoom);
    const [x0, y0] = lastRef.current ?? [x, y];
    // Linha entre amostras do ponteiro: traço contínuo mesmo com movimento rápido.
    const steps = Math.max(Math.abs(x - x0), Math.abs(y - y0), 1);
    for (let s = 0; s <= steps; s++) stamp(Math.round(x0 + ((x - x0) * s) / steps), Math.round(y0 + ((y - y0) * s) / steps));
    lastRef.current = [x, y];
    touch();
  }

  function fill(value: 0 | 255 | "invert") {
    const mask = maskRef.current;
    if (!mask) return;
    for (let i = 0; i < mask.length; i++) mask[i] = value === "invert" ? 255 - mask[i]! : value;
    touch();
  }

  /** Envia a máscara como upload (uma vez por conteúdo) e espera a normalização. */
  async function uploadMask(): Promise<string> {
    const png = await maskPng(maskRef.current!, w, h);
    const digest = await sha256Hex(png);
    if (uploaded.current?.digest === digest) return uploaded.current.uploadId;
    const form = new FormData();
    form.append("file", new Blob([png as BlobPart], { type: "image/png" }), `mascara-${digest.slice(0, 8)}.png`);
    const res = await fetch(`/api/v1${base}/uploads`, { method: "POST", body: form });
    const body = (await res.json()) as { upload?: UploadView; message?: string };
    if (!res.ok || !body.upload) throw new Error(body.message ?? "Falha ao enviar a máscara");
    for (let i = 0; i < 60; i++) {
      const { upload } = await apiFetch<{ upload: UploadView }>(`${base}/uploads/${body.upload.id}`);
      if (upload.status === "ready") {
        uploaded.current = { digest, uploadId: upload.id };
        return upload.id;
      }
      if (upload.status === "rejected") throw new Error("A máscara não pôde ser importada");
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error("A importação da máscara demorou demais");
  }

  async function loadPlan() {
    setMessage(null);
    setBusy(true);
    try {
      if (!profile || !effectiveMode) throw new Error("Nenhum perfil com inpainting disponível");
      const maskUploadId = await uploadMask();
      const p = await apiFetch<PlanPreview>(`${base}/generation-plans`, {
        method: "POST",
        json: { operation: "inpaint", providerProfileId: profile.id, sourceRevisionId: revisionId, sourceFileKey: fileKey, maskUploadId, instruction, mode: effectiveMode },
      });
      setPreview(p);
      return p;
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : String(err instanceof Error ? err.message : err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    const p = preview ?? (await loadPlan());
    if (!p) return;
    try {
      const res = await apiFetch<{ job: JobView; created: boolean }>(`${base}/jobs`, {
        method: "POST",
        // Mesmo plano (mesma máscara, instrução e perfil) = mesmo job: duplo clique não cobra duas vezes.
        headers: { "idempotency-key": `inpaint:${p.digest}` },
        json: { kind: "generation", request: { plan: p.plan, planDigest: p.digest, targetAssetId: assetId } },
      });
      setJobId(res.job.id);
      setMessage(res.created ? `Job ${res.job.id} enfileirado.` : `Mesmo pedido: job ${res.job.id} já existe (nenhum envio duplicado).`);
    } catch (err) {
      setMessage(err instanceof ApiError ? `${err.message} (${err.code})` : String(err));
    }
  }

  if (!data) return <p className="muted">Carregando…</p>;
  if (!source || !file) return <p className="error">Revisão ou arquivo não encontrado neste asset.</p>;
  if (source.status !== "approved") return <p className="error">O inpainting parte de uma revisão aprovada; aprove r{source.number} antes.</p>;

  return (
    <>
      <h1>
        Inpainting · {data.asset.name} <span className="muted small">r{source.number} · {fileKey} · {w}×{h}</span>
      </h1>
      <div className="grid2">
        <section>
          <h2>Máscara</h2>
          <div className="row">
            <label>
              Ferramenta
              <select value={tool} onChange={(e) => setTool(e.target.value as "paint" | "erase")}>
                <option value="paint">pintar (editar)</option>
                <option value="erase">apagar (proteger)</option>
              </select>
            </label>
            <label>
              Pincel
              <select value={brush} onChange={(e) => setBrush(Number(e.target.value))}>
                {[1, 2, 4, 8, 16].map((b) => (
                  <option key={b} value={b}>
                    {b} px
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="secondary" onClick={() => fill(0)}>
              Limpar
            </button>
            <button type="button" className="secondary" onClick={() => fill(255)}>
              Tudo
            </button>
            <button type="button" className="secondary" onClick={() => fill("invert")}>
              Inverter
            </button>
            <label style={{ flexDirection: "row", alignItems: "center", gap: 4, color: "inherit" }}>
              <input type="checkbox" checked={showOverlay} onChange={(e) => setShowOverlay(e.target.checked)} /> sobreposição
            </label>
          </div>
          <canvas
            ref={canvasRef}
            className="pixel bg-checker"
            style={{ touchAction: "none", cursor: "crosshair", maxWidth: "100%" }}
            onPointerDown={(e) => {
              try {
                e.currentTarget.setPointerCapture(e.pointerId); // traço continua mesmo saindo do canvas
              } catch {
                /* ponteiro sem captura (ex.: evento sintético): pinta do mesmo jeito */
              }
              lastRef.current = null;
              paintTo(e);
            }}
            onPointerMove={(e) => e.buttons === 1 && paintTo(e)}
            onPointerUp={() => (lastRef.current = null)}
          />
          <p className="small muted">Rosa: região que o modelo pode refazer. Fora dela, cada pixel sai idêntico à fonte.</p>
        </section>
        <section>
          <h2>Pedido</h2>
          <label>
            O que deve existir na região
            <textarea value={instruction} maxLength={1000} onChange={(e) => (setInstruction(e.target.value), setPreview(null))} placeholder="ex.: reconstruir a margem do lago com juncos" />
          </label>
          <div className="row">
            <label>
              Perfil
              <select value={profile?.id ?? ""} onChange={(e) => (setProfileId(e.target.value), setMode(""), setPreview(null))}>
                {data.profiles.length === 0 && <option value="">Nenhum perfil com inpainting</option>}
                {data.profiles.map((p) => (
                  <option key={p.id} value={p.id} disabled={Boolean(p.unavailable)}>
                    {p.name}
                    {p.unavailable ? " (indisponível)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Modo
              <select value={effectiveMode ?? ""} onChange={(e) => (setMode(e.target.value as Mode), setPreview(null))}>
                {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
                  <option key={m} value={m} disabled={!caps.includes(m === "native-mask" ? "native_mask" : "image_edit")}>
                    {MODE_LABEL[m]}
                    {!caps.includes(m === "native-mask" ? "native_mask" : "image_edit") ? " — indisponível neste perfil" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button type="button" className="secondary" disabled={busy || !instruction.trim()} onClick={loadPlan}>
              Prévia do plano
            </button>
            <button type="button" disabled={busy || !instruction.trim()} onClick={run}>
              Executar
            </button>
          </div>
          {message && <p className="small">{message}</p>}
          {preview && (
            <div className="small">
              <p>
                <strong>{preview.modeLabel}</strong> · destino {preview.destination.name}
                {preview.destination.simulated ? " (simulado, nada sai do computador)" : ""} · estimativa {estimateText(preview.plan)}
              </p>
              <p>{preview.scope}</p>
              <pre>{preview.plan.prompt.compiled}</pre>
            </div>
          )}
        </section>
      </div>
      {jobId && <InpaintResult projectId={projectId} assetId={assetId} source={source} fileKey={fileKey} jobId={jobId} />}
    </>
  );
}

function InpaintResult({ projectId, assetId, source, fileKey, jobId }: { projectId: string; assetId: string; source: RevisionView; fileKey: string; jobId: string }) {
  const base = `/projects/${projectId}`;
  const [bg, setBg] = useState<PreviewBg>("checker");
  const { data } = usePoll(
    async () => {
      const { job } = await apiFetch<{ job: JobView }>(`${base}/jobs/${jobId}`);
      const revisionId = (job.result as { revisionIds?: string[] } | null)?.revisionIds?.[0];
      const revision = revisionId ? (await apiFetch<{ revisions: RevisionView[] }>(`${base}/assets/${assetId}`)).revisions.find((r) => r.id === revisionId) : undefined;
      return { job, revision };
    },
    { active: (d) => d.job.state === "queued" || d.job.state === "running", fastMs: 800, slowMs: 30_000 },
  );
  if (!data) return null;
  const { job, revision } = data;
  if (job.state !== "succeeded" || !revision) {
    return (
      <section>
        <h2>Resultado</h2>
        <p className="small">
          Job {job.id}: <span className={`badge state-${job.state}`}>{job.state}</span> {job.stage ? `· etapa ${job.stage}` : ""}
          {job.error ? <span className="error"> · {(job.error as { message?: string }).message}</span> : null}
        </p>
      </section>
    );
  }
  const media = (key: string) => {
    const f = revision.files.find((x) => x.fileKey === key);
    return f ? `/api/v1/projects/${projectId}/media/${f.id}` : null;
  };
  const sourceFile = source.files.find((f) => f.fileKey === fileKey)!;
  const report = revision.technicalReport as { modeLabel: string; composite: { editedPixels: number; protectedPixels: number; protectedDiffPixels: number; candidateAgreement: number | null }; warnings: string[] };
  return (
    <section>
      <h2>Resultado · r{revision.number} (candidata)</h2>
      <p className="small">
        {report.modeLabel} · {report.composite.editedPixels} pixel(s) editados · {report.composite.protectedPixels} protegidos ·{" "}
        <strong>{report.composite.protectedDiffPixels} diferença(s) fora da máscara</strong>
        {report.composite.candidateAgreement !== null ? ` · o candidato coincide com a fonte em ${(report.composite.candidateAgreement * 100).toFixed(0)}% da área protegida` : ""}
      </p>
      {report.warnings.length > 0 && (
        <ul className="small">
          {report.warnings.map((wn, i) => (
            <li key={i} className="error">
              {wn}
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <label>
          Fundo
          <select value={bg} onChange={(e) => setBg(e.target.value as PreviewBg)}>
            <option value="checker">quadriculado</option>
            <option value="dark">escuro</option>
            <option value="light">claro</option>
          </select>
        </label>
      </div>
      <div className="row" style={{ alignItems: "flex-start" }}>
        {[
          ["Candidato (na grade da fonte)", media("inpaint-candidate")],
          ["Máscara", media("inpaint-mask")],
        ].map(([label, url]) =>
          url ? (
            <figure key={label} style={{ margin: 0 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className={`pixel bg-${bg}`} alt={label!} src={url} style={{ width: 256, imageRendering: "pixelated" }} />
              <figcaption className="small">{label}</figcaption>
            </figure>
          ) : null,
        )}
      </div>
      <RevisionCompare
        a={{ label: `Fonte r${source.number}`, src: `/api/v1/projects/${projectId}/media/${sourceFile.id}` }}
        b={{ label: `Resultado r${revision.number}`, src: media(fileKey)! }}
        zoom={2}
        bg={bg}
      />
      <p className="small">
        Aprove ou reprove a revisão na <Link href={`/projects/${projectId}`}>biblioteca do projeto</Link>.
      </p>
    </section>
  );
}
