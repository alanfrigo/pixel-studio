"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { GenerationPlan, ReferenceRole } from "@/contracts";
import type { AssetView, ProjectView, RevisionView, UploadView } from "@/server/catalog/catalog";
import type { ExportView } from "@/server/export/exports";
import type { JobView } from "@/server/jobs/queue";
import type { ProviderProfileView } from "@/server/providers/registry";
import { ApiError, apiFetch, formatBytes, newKey } from "@/app/client/api";
import { estimateText } from "@/app/client/cost";
import { usePoll } from "@/app/client/use-poll";
import { type PreviewBg, RevisionCompare } from "./revision-compare";
import { StylePanel } from "./style-panel";

type Lineage = Record<string, { revisionId: string; assetName: string; number: number; role: string; runtime: boolean }[]>;

interface Snapshot {
  project: ProjectView;
  palette: string[];
  briefLanguage: "pt-BR" | "en";
  jobs: JobView[];
  uploads: UploadView[];
  assets: { asset: AssetView; revisions: RevisionView[]; lineage: Lineage }[];
  exports: ExportView[];
}

const ACTIVE = new Set(["queued", "running"]);

export function Workspace({ projectId }: { projectId: string }) {
  const base = `/projects/${projectId}`;
  const { data, error, refresh } = usePoll<Snapshot>(
    async () => {
      const [{ project, style }, { jobs }, { uploads }, { assets }, { exports }] = await Promise.all([
        apiFetch<{ project: ProjectView; style: { payload: { palette: { colors: { hex: string }[] }; briefLanguage: string } } | null }>(base),
        apiFetch<{ jobs: JobView[] }>(`${base}/jobs`),
        apiFetch<{ uploads: UploadView[] }>(`${base}/uploads`),
        apiFetch<{ assets: AssetView[] }>(`${base}/assets`),
        apiFetch<{ exports: ExportView[] }>(`${base}/exports`),
      ]);
      const detailed = await Promise.all(assets.map((a) => apiFetch<{ asset: AssetView; revisions: RevisionView[]; lineage: Lineage }>(`${base}/assets/${a.id}`)));
      return {
        project,
        palette: style?.payload.palette.colors.map((c) => c.hex) ?? [],
        briefLanguage: style?.payload.briefLanguage === "en" ? "en" : "pt-BR",
        jobs,
        uploads,
        assets: detailed,
        exports,
      };
    },
    { active: (s) => s.jobs.some((j) => ACTIVE.has(j.state)) || s.uploads.some((u) => u.status === "pending"), fastMs: 800, slowMs: 6000 },
  );

  if (error && !data) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Carregando…</p>;

  return (
    <>
      <h1>{data.project.name}</h1>
      <nav className="row small" aria-label="Ferramentas do projeto">
        <Link href={`/projects/${projectId}/animation`}>Animação, estados e edição temporal</Link>
        <span className="muted">·</span>
        <Link href={`/projects/${projectId}/equipment`}>Equipamentos e conjuntos</Link>
        <span className="muted">·</span>
        <Link href={`/projects/${projectId}/world`}>Mundo: texturas, tiles e mapas</Link>
        <span className="muted">·</span>
        <Link href={`/projects/${projectId}/scenes`}>Cenas, salas e móveis</Link>
      </nav>
      <div className="grid2">
        <GeneratePanel projectId={projectId} library={data.assets} defaultLanguage={data.briefLanguage} onChange={refresh} />
        <UploadPanel projectId={projectId} uploads={data.uploads} onChange={refresh} />
      </div>
      <JobsPanel projectId={projectId} jobs={data.jobs} assetOfRevision={new Map(data.assets.flatMap((a) => a.revisions.map((r) => [r.id, a.asset.id] as const)))} onChange={refresh} />
      <StylePanel projectId={projectId} onChange={refresh} />
      <AssetsPanel projectId={projectId} assets={data.assets} palette={data.palette} onChange={refresh} />
      <UiComponentsPanel projectId={projectId} assets={data.assets.map((a) => a.asset)} onChange={refresh} />
      <ExportPanel projectId={projectId} assets={data.assets.map((a) => a.asset)} exports={data.exports} onChange={refresh} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Geração por texto puro
// ---------------------------------------------------------------------------

interface PlanPreview {
  plan: GenerationPlan;
  digest: string;
  destination: { profileId: string; name: string; transport: string; simulated: boolean };
}

/** Papéis das ligações entre revisões, como aparecem na origem de cada revisão. */
const EDGE_ROLE: Record<string, string> = {
  source: "origem",
  reference: "referência",
  component: "componente",
  font: "fonte",
  clip: "clipe",
  rig: "esqueleto",
  overlay: "sobreposição",
  base: "base",
  motion: "movimento",
  audio: "áudio",
  vfx: "efeito",
  identity: "identidade",
  style: "estilo",
  palette: "paleta",
  silhouette: "silhueta",
  material: "material",
  pose: "pose",
  equipment: "equipamento",
  composition: "composição",
};

const ROLES: [ReferenceRole, string][] = [
  ["identity", "identidade"],
  ["style", "estilo"],
  ["palette", "paleta"],
  ["silhouette", "silhueta"],
  ["material", "material"],
  ["pose", "pose"],
  ["equipment", "equipamento"],
  ["composition", "composição"],
];

interface RefChoice {
  revisionId: string;
  fileKey: string;
  fileId: string;
  label: string;
  role: ReferenceRole;
  instruction: string;
}

function GeneratePanel({
  projectId,
  library,
  defaultLanguage,
  onChange,
}: {
  projectId: string;
  library: { asset: AssetView; revisions: RevisionView[] }[];
  defaultLanguage: "pt-BR" | "en";
  onChange: () => void;
}) {
  const base = `/projects/${projectId}`;
  const assets = library.map((l) => l.asset);
  const { data: providers } = usePoll(
    () => apiFetch<{ profiles: (ProviderProfileView & { capabilities: Record<string, string[]>; unavailable: string | null })[] }>("/settings/providers"),
    { active: () => false, slowMs: 60_000 },
  );
  const [target, setTarget] = useState<string>("new");
  const [name, setName] = useState("Poção verde");
  const [brief, setBrief] = useState("poção verde em frasco de vidro, rolha de cortiça");
  const [size, setSize] = useState(16);
  const [variants, setVariants] = useState(2);
  const [profileId, setProfileId] = useState("simulated");
  const [language, setLanguage] = useState<"pt-BR" | "en" | null>(null);
  const [refs, setRefs] = useState<RefChoice[]>([]);
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Uma intenção = uma chave de idempotência + um asset alvo. Cliques repetidos reutilizam ambos.
  const intent = useRef<{ digest: string; key: string; asset: Promise<string> | null } | null>(null);

  const itemAssets = assets.filter((a) => a.family === "item");
  const input = () => ({
    operation: "generate_asset" as const,
    providerProfileId: profileId,
    brief,
    language: language ?? defaultLanguage,
    params: { family: "item" as const, kind: "consumable" as const, logicalSize: [size, size] as [number, number], transparent: true, variants },
    references: refs.map((r) => ({ revisionId: r.revisionId, fileKey: r.fileKey, role: r.role, ...(r.instruction.trim() ? { instruction: r.instruction.trim() } : {}) })),
  });
  // Só revisões aprovadas servem de referência (o plano recusa as demais).
  const refOptions = library.flatMap(({ asset, revisions }) =>
    revisions
      .filter((r) => r.status === "approved")
      .flatMap((r) =>
        r.files
          .filter((f) => f.mime.startsWith("image/") && f.metadata.width)
          .map((f) => ({ key: `${r.id}|${f.fileKey}`, revisionId: r.id, fileKey: f.fileKey, fileId: f.id, label: `${asset.name} · r${r.number} · ${f.fileKey}` })),
      ),
  );
  const updateRefs = (next: RefChoice[]) => (setRefs(next), setPreview(null));
  const moveRef = (i: number, delta: number) => {
    const next = [...refs];
    const [item] = next.splice(i, 1);
    next.splice(i + delta, 0, item!);
    updateRefs(next);
  };

  async function loadPreview(): Promise<PlanPreview> {
    const p = await apiFetch<PlanPreview>(`${base}/generation-plans`, { method: "POST", json: input() });
    setPreview(p);
    if (intent.current?.digest !== p.digest) intent.current = { digest: p.digest, key: newKey("gen"), asset: null };
    return p;
  }

  async function generate(newVariation: boolean) {
    setMessage(null);
    try {
      const p = preview && intent.current?.digest === preview.digest ? preview : await loadPreview();
      if (newVariation || !intent.current) intent.current = { digest: p.digest, key: newKey("gen"), asset: null };
      const current = intent.current;
      current.asset ??=
        target === "new"
          ? apiFetch<{ asset: AssetView }>(`${base}/assets`, { method: "POST", json: { family: "item", kind: "consumable", name } }).then((r) => r.asset.id)
          : Promise.resolve(target);
      const assetId = await current.asset;
      const res = await apiFetch<{ job: JobView; created: boolean }>(`${base}/jobs`, {
        method: "POST",
        headers: { "idempotency-key": `${current.key}:${assetId}` },
        json: { kind: "generation", request: { plan: p.plan, planDigest: p.digest, targetAssetId: assetId } },
      });
      setMessage(res.created ? `Job ${res.job.id} enfileirado.` : `Mesmo pedido: job ${res.job.id} já existe (nenhum envio duplicado).`);
      onChange();
    } catch (err) {
      setMessage(err instanceof ApiError ? `${err.message} (${err.code})` : String(err));
    }
  }

  const invalidate = () => setPreview(null);

  return (
    <section>
      <h2>Gerar ícone</h2>
      <form onSubmit={(e) => e.preventDefault()}>
        <label>
          Asset
          <select value={target} onChange={(e) => (setTarget(e.target.value), (intent.current = null))}>
            <option value="new">Novo asset…</option>
            {itemAssets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        {target === "new" && (
          <label>
            Nome
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </label>
        )}
        <label>
          Tamanho
          <select value={size} onChange={(e) => (setSize(Number(e.target.value)), invalidate())}>
            {[16, 24, 32, 48, 64].map((n) => (
              <option key={n} value={n}>
                {n} × {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          Idioma do prompt
          <select value={language ?? defaultLanguage} onChange={(e) => (setLanguage(e.target.value as "pt-BR" | "en"), invalidate())}>
            <option value="pt-BR">pt-BR</option>
            <option value="en">en</option>
          </select>
        </label>
        <label>
          Variantes
          <select value={variants} onChange={(e) => (setVariants(Number(e.target.value)), invalidate())}>
            {[1, 2, 3, 4].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label>
          Provedor
          <select value={profileId} onChange={(e) => (setProfileId(e.target.value), invalidate())}>
            {providers?.profiles.map((p) => (
              <option key={p.id} value={p.id} disabled={Boolean(p.unavailable)}>
                {p.name}
                {p.unavailable ? " (indisponível)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label style={{ flexBasis: "100%" }}>
          Descrição
          <textarea value={brief} onChange={(e) => (setBrief(e.target.value), invalidate())} maxLength={2000} />
        </label>
        <div style={{ flexBasis: "100%" }}>
          <div className="small muted">Referências, na ordem em que o modelo as recebe (Imagem 1, 2…)</div>
          <ol className="list">
            {refs.map((r, i) => (
              <li key={`${r.revisionId}|${r.fileKey}|${i}`} className="row">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="pixel" alt="" src={`/api/v1/projects/${projectId}/media/${r.fileId}`} style={{ maxWidth: 48, maxHeight: 48 }} />
                <span className="small">
                  <strong>Imagem {i + 1}</strong> · {r.label}
                </span>
                <select aria-label={`Papel da imagem ${i + 1}`} value={r.role} onChange={(e) => updateRefs(refs.map((x, j) => (j === i ? { ...x, role: e.target.value as ReferenceRole } : x)))}>
                  {ROLES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={`Instrução da imagem ${i + 1}`}
                  placeholder="ex.: só o formato do frasco"
                  value={r.instruction}
                  maxLength={300}
                  onChange={(e) => updateRefs(refs.map((x, j) => (j === i ? { ...x, instruction: e.target.value } : x)))}
                />
                <button type="button" className="secondary" aria-label="Subir" disabled={i === 0} onClick={() => moveRef(i, -1)}>
                  ↑
                </button>
                <button type="button" className="secondary" aria-label="Descer" disabled={i === refs.length - 1} onClick={() => moveRef(i, 1)}>
                  ↓
                </button>
                <button type="button" className="secondary" aria-label="Remover" onClick={() => updateRefs(refs.filter((_, j) => j !== i))}>
                  ×
                </button>
              </li>
            ))}
          </ol>
          <select
            aria-label="Adicionar referência"
            value=""
            disabled={refOptions.length === 0}
            onChange={(e) => {
              const o = refOptions.find((x) => x.key === e.target.value);
              if (o) updateRefs([...refs, { revisionId: o.revisionId, fileKey: o.fileKey, fileId: o.fileId, label: o.label, role: refs.length === 0 ? "identity" : "style", instruction: "" }]);
            }}
          >
            <option value="">{refOptions.length ? "+ adicionar referência aprovada…" : "Nenhuma revisão aprovada para usar como referência"}</option>
            {refOptions.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="secondary" onClick={() => loadPreview().catch((e) => setMessage(String(e.message ?? e)))}>
          Prévia do plano
        </button>
        <button type="button" onClick={() => generate(false)}>
          Gerar
        </button>
        <button type="button" className="secondary" onClick={() => generate(true)}>
          Nova variação
        </button>
      </form>
      {message && <p className="small">{message}</p>}
      {preview && (
        <div className="small">
          <p>
            Destino: <strong>{preview.destination.name}</strong>
            {preview.destination.simulated && " — nada sai do computador"} · partes: {preview.plan.parts.length} · estimativa: {estimateText(preview.plan)}
          </p>
          <pre>{preview.plan.prompt.compiled}</pre>
          <p className="muted">
            Plano {preview.digest.slice(0, 12)} · referências: {refs.length === 0 ? "nenhuma (texto puro)" : refs.length}
            {preview.plan.operation === "generate_asset" && preview.plan.params.backgroundKey ? ` · rota sem alfa: fundo ${preview.plan.params.backgroundKey} removido localmente` : ""}
          </p>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

function UploadPanel({ projectId, uploads, onChange }: { projectId: string; uploads: UploadView[]; onChange: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function createItemFromUpload(u: UploadView) {
    setMessage(null);
    try {
      const name = u.originalName.replace(/\.[a-z0-9]+$/i, "") || "Item importado";
      const { asset } = await apiFetch<{ asset: AssetView }>(`/projects/${projectId}/assets`, {
        method: "POST",
        json: { family: "item", kind: "consumable", name },
      });
      await apiFetch(`/projects/${projectId}/assets/${asset.id}/revisions`, { method: "POST", json: { from: "upload", uploadId: u.id } });
      setMessage(`Item "${name}" criado como candidato.`);
      onChange();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    setMessage("Enviando…");
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/uploads`, { method: "POST", body: form });
      const body = await res.json();
      setMessage(res.ok ? `Recebido; normalização no job ${body.job.id}.` : `${body.message} (${body.code})`);
      if (fileRef.current) fileRef.current.value = "";
      onChange();
    } catch (err) {
      setMessage(String(err));
    }
  }

  return (
    <section>
      <h2>Importar arquivo</h2>
      <p className="muted small">Imagem, WAV, fonte ou um pacote ZIP exportado (reabre as revisões como candidatas).</p>
      <form onSubmit={upload}>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp,audio/wav,.ttf,.otf,.zip" />
        <button>Importar</button>
      </form>
      {message && <p className="small">{message}</p>}
      <ul className="list">
        {uploads.slice(0, 8).map((u) => (
          <li key={u.id} className="row">
            {u.modality === "raster" && u.status === "ready" && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="pixel" alt={u.originalName} src={`/api/v1/projects/${projectId}/media/${u.id}`} style={{ maxWidth: 64, maxHeight: 64 }} />
            )}
            <span>{u.originalName}</span>
            <span className={`badge state-${u.status}`}>{u.status}</span>
            <span className="muted small">
              {u.modality}
              {u.metadata?.width ? ` · ${u.metadata.width}×${u.metadata.height}` : ""}
              {u.metadata?.durationMs ? ` · ${u.metadata.durationMs} ms` : ""}
              {u.metadata?.package ? ` · pacote com ${(u.metadata.package as { revisions: number }).revisions} revisões` : ""}
            </span>
            {u.status === "rejected" && <span className="error small">{(u.error as { message?: string })?.message}</span>}
            {u.status === "ready" && u.modality === "raster" && (
              <button className="secondary" onClick={() => createItemFromUpload(u)}>
                Criar item
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Fila
// ---------------------------------------------------------------------------

const STATE_LABEL: Record<string, string> = {
  queued: "na fila",
  running: "executando",
  succeeded: "concluído",
  failed: "falhou",
  cancelled: "cancelado",
  needs_attention: "precisa de decisão",
};

const JOB_LABEL: Record<string, string> = {
  generation: "Geração",
  ingest: "Importação",
  export: "Exportação",
  local_process: "Processamento local",
};

const OPERATION_LABEL: Record<string, string> = {
  remove_background_flood: "remover fundo",
  apply_palette: "aplicar paleta",
  crop_to_content: "recorte justo",
  slice_grid: "fatiar folha",
  compose_layers: "compor camadas",
  composite_protected: "restaurar área protegida",
  make_thumbnail: "miniatura",
};

const REMOTE_LABEL: Record<string, string> = {
  not_sent: "não enviado",
  sending: "enviando",
  accepted: "aceito pelo provedor",
  uncertain: "envio incerto",
  completed: "resposta salva",
  rejected: "recusado",
};

function JobsPanel({ projectId, jobs, assetOfRevision, onChange }: { projectId: string; jobs: JobView[]; assetOfRevision: Map<string, string>; onChange: () => void }) {
  const [message, setMessage] = useState<string | null>(null);

  async function act(job: JobView, action: "cancel" | "retry") {
    setMessage(null);
    let acknowledgePossibleCharge = false;
    if (action === "retry" && job.actions.retryMayCharge) {
      acknowledgePossibleCharge = window.confirm(
        "Há envio com resultado e cobrança desconhecidos. Tentar de novo pode gerar uma nova cobrança no provedor. Continuar?",
      );
      if (!acknowledgePossibleCharge) return;
    }
    try {
      await apiFetch(`/projects/${projectId}/jobs/${job.id}/${action}`, { method: "POST", json: action === "retry" ? { acknowledgePossibleCharge } : {} });
      onChange();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section>
      <h2>Fila</h2>
      {message && <p className="error small">{message}</p>}
      {jobs.length === 0 && <p className="muted">Nenhum job ainda.</p>}
      <ul className="list">
        {jobs.map((job) => {
          const error = job.error as { message?: string; code?: string } | null;
          return (
            <li key={job.id}>
              <div className="row">
                <strong>{JOB_LABEL[job.kind] ?? job.kind}</strong>
                <span className={`badge state-${job.state}`}>{STATE_LABEL[job.state] ?? job.state}</span>
                <span className="muted small">
                  etapa {job.stage} · tentativa {job.attemptCount}/{job.maxAttempts}
                  {job.cancelRequested && " · cancelamento solicitado"}
                  {job.kind === "generation" && ` · chamadas ao provedor: ${job.summary.submissions}`}
                  {job.summary.cost.map((c) => ` · custo ${c.amount} ${c.unit}`).join("")}
                </span>
                {job.actions.canCancel && (
                  <button className="secondary" onClick={() => act(job, "cancel")}>
                    Cancelar
                  </button>
                )}
                {job.actions.canRetry && <button onClick={() => act(job, "retry")}>Tentar de novo</button>}
              </div>
              {job.parts.length > 0 && (
                <div className="muted small">
                  {job.parts.map((p) => `${p.partKey}: ${REMOTE_LABEL[p.remoteState]}${p.processed ? ", processada" : ""}`).join(" · ")}
                </div>
              )}
              {error?.message && job.state !== "succeeded" && (
                <div className={job.state === "queued" ? "small" : "error small"}>
                  {job.state === "queued" ? "Última falha (nova tentativa agendada): " : ""}
                  {error.message}
                </div>
              )}
              {job.kind === "local_process" && job.state === "succeeded" && <LocalOutputs projectId={projectId} job={job} assetOfRevision={assetOfRevision} onChange={onChange} />}
              <div className="muted small">{job.id}</div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Assets e revisões
// ---------------------------------------------------------------------------

function AssetsPanel({
  projectId,
  assets,
  palette,
  onChange,
}: {
  projectId: string;
  assets: { asset: AssetView; revisions: RevisionView[]; lineage: Lineage }[];
  palette: string[];
  onChange: () => void;
}) {
  const [family, setFamily] = useState("all");
  const [status, setStatus] = useState<"all" | "pending" | "approved">("all");
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(4);
  const [bg, setBg] = useState<PreviewBg>("checker");
  const [compare, setCompare] = useState<string[]>([]);
  const families = [...new Set(assets.map((a) => a.asset.family))].sort();
  const visible = assets.filter(
    ({ asset, revisions }) =>
      (family === "all" || asset.family === family) &&
      (status === "all" || (status === "pending" ? revisions.some((r) => r.status === "candidate") : asset.approvedRevisionId !== null)) &&
      (!query.trim() || asset.name.toLowerCase().includes(query.trim().toLowerCase())),
  );
  const imageOf = (rev: RevisionView) => rev.files.find((f) => f.fileKey === "image") ?? rev.files.find((f) => f.role === "normalized") ?? rev.files.find((f) => f.mime.startsWith("image/"));
  const byId = new Map(assets.flatMap(({ asset, revisions }) => revisions.map((r) => [r.id, { asset, rev: r }] as const)));
  const side = (id: string) => {
    const hit = byId.get(id);
    const file = hit && imageOf(hit.rev);
    return hit && file ? { label: `${hit.asset.name} r${hit.rev.number}`, src: `/api/v1/projects/${projectId}/media/${file.id}` } : null;
  };
  const toggleCompare = (id: string) => setCompare((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id].slice(-2)));
  const [sideA, sideB] = [compare[0] ? side(compare[0]) : null, compare[1] ? side(compare[1]) : null];

  async function workshop(rev: RevisionView, fileId: string, operation: "remove_background_flood" | "apply_palette") {
    setMessage(null);
    try {
      let recipe: Record<string, unknown>;
      if (operation === "remove_background_flood") {
        const corner = await sampleCorner(`/api/v1/projects/${projectId}/media/${fileId}`);
        if (corner.alpha === 0) return setMessage("O canto já é transparente: não há fundo uniforme para remover.");
        recipe = { version: 1, color: corner.hex, tolerance: 24, seeds: { borders: true, points: [] }, connectivity: 4 };
      } else {
        recipe = { version: 1, metric: "srgb8_squared", tieBreak: "lowest_index", dither: false, colors: palette };
      }
      const request = { operation, inputs: [{ role: "source", ref: { kind: "revision", revisionId: rev.id, fileKey: "image" } }], recipe };
      await apiFetch(`/projects/${projectId}/jobs`, {
        method: "POST",
        // Mesma revisão + mesma receita = mesmo job (clique repetido não duplica).
        headers: { "idempotency-key": `local:${operation}:${rev.id}:${await sha256Hex(JSON.stringify(recipe))}` },
        json: { kind: "local_process", request },
      });
      onChange();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  const [message, setMessage] = useState<string | null>(null);

  async function review(asset: AssetView, revision: RevisionView, decision: "approve" | "reject" | "promote") {
    setMessage(null);
    const reason = decision === "reject" ? window.prompt("Motivo da reprovação") : null;
    if (decision === "reject" && !reason) return;
    try {
      await apiFetch(`/projects/${projectId}/assets/${asset.id}/reviews`, {
        method: "POST",
        json: { revisionId: revision.id, decision, reason, expectedActiveRevisionId: asset.approvedRevisionId },
      });
    } catch (err) {
      setMessage(
        err instanceof ApiError && err.status === 409
          ? "Outra aba alterou a revisão ativa deste asset. A tela foi atualizada; confira antes de decidir de novo."
          : String(err instanceof Error ? err.message : err),
      );
    }
    onChange();
  }

  return (
    <section>
      <h2>Biblioteca</h2>
      <div className="row">
        <label>
          Família
          <select value={family} onChange={(e) => setFamily(e.target.value)}>
            <option value="all">todas</option>
            {families.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>
        <label>
          Situação
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="all">todas</option>
            <option value="pending">com candidata a revisar</option>
            <option value="approved">com revisão ativa</option>
          </select>
        </label>
        <label>
          Buscar
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="nome do asset" />
        </label>
        <label>
          Zoom
          <select value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
            {[1, 2, 4, 8].map((z) => (
              <option key={z} value={z}>
                {z}×
              </option>
            ))}
          </select>
        </label>
        <label>
          Fundo
          <select value={bg} onChange={(e) => setBg(e.target.value as PreviewBg)}>
            <option value="checker">quadriculado</option>
            <option value="dark">escuro</option>
            <option value="light">claro</option>
          </select>
        </label>
        <span className="small muted">
          {visible.length} de {assets.length} asset(s)
        </span>
      </div>
      {sideA && sideB && <RevisionCompare a={sideA} b={sideB} zoom={zoom} bg={bg} onClose={() => setCompare([])} />}
      {compare.length === 1 && <p className="small muted">Escolha mais uma revisão para comparar.</p>}
      {message && <p className="error small">{message}</p>}
      {assets.length === 0 && <p className="muted">Nenhum asset ainda.</p>}
      {visible.map(({ asset, revisions, lineage }) => (
        <div key={asset.id} style={{ marginBottom: 16 }}>
          <div className="row">
            <strong>{asset.name}</strong>
            <span className="muted small">
              {asset.family}/{asset.kind} · {revisions.length} revisão(ões)
            </span>
          </div>
          <div className="revisions">
            {revisions.map((rev) => {
              const image = imageOf(rev);
              const w = Number(image?.metadata.width ?? 16);
              const h = Number(image?.metadata.height ?? 16);
              const report = rev.technicalReport as { sizeMatches?: boolean; receivedSize?: number[]; warnings?: string[] } | null;
              const active = asset.approvedRevisionId === rev.id;
              return (
                <div key={rev.id} className={["revision", active && "active", compare.includes(rev.id) && "selected"].filter(Boolean).join(" ")}>
                  {image && (
                    <div className="row">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img className={`pixel bg-${bg}`} alt={`r${rev.number} 1×`} src={`/api/v1/projects/${projectId}/media/${image.id}`} width={w} height={h} />
                      {zoom > 1 && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img className={`pixel bg-${bg}`} alt={`r${rev.number} ${zoom}×`} src={`/api/v1/projects/${projectId}/media/${image.id}`} width={w * zoom} height={h * zoom} />
                      )}
                    </div>
                  )}
                  <div className="small">
                    r{rev.number} <span className={`badge state-${rev.status}`}>{active ? "ativa" : rev.status}</span>{" "}
                    <span className="muted">{rev.origin}</span>
                  </div>
                  {report?.sizeMatches === false && <div className="error small">Tamanho recebido {report.receivedSize?.join("×")} difere do pedido</div>}
                  {(rev.predecessorId || lineage[rev.id]?.length) && (
                    <div className="small muted">
                      {rev.predecessorId && <>após r{byId.get(rev.predecessorId)?.rev.number ?? "?"}</>}
                      {lineage[rev.id]?.map((l) => (
                        <span key={`${l.revisionId}-${l.role}`}>
                          {" "}
                          · {EDGE_ROLE[l.role] ?? l.role.replaceAll("_", " ")} de {l.assetName} r{l.number}
                          {l.runtime ? " (usada no jogo)" : ""}
                        </span>
                      ))}
                    </div>
                  )}
                  {(report?.warnings?.length ?? 0) > 0 && (
                    <details className="small">
                      <summary>{report!.warnings!.length} aviso(s) técnico(s)</summary>
                      <ul>
                        {report!.warnings!.map((wn, i) => (
                          <li key={i}>{wn}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <div className="row">
                    {rev.status !== "approved" && <button onClick={() => review(asset, rev, "approve")}>Aprovar</button>}
                    {rev.status === "approved" && !active && (
                      <button className="secondary" onClick={() => review(asset, rev, "promote")}>
                        Tornar ativa
                      </button>
                    )}
                    {rev.status === "candidate" && (
                      <button className="secondary" onClick={() => review(asset, rev, "reject")}>
                        Reprovar
                      </button>
                    )}
                    {image && rev.status === "approved" && (
                      <Link className="button secondary" href={`/projects/${projectId}/inpaint?asset=${asset.id}&revision=${rev.id}&file=${encodeURIComponent(image.fileKey)}`}>
                        Inpainting
                      </Link>
                    )}
                    {image && (
                      <button className="secondary" aria-pressed={compare.includes(rev.id)} onClick={() => toggleCompare(rev.id)}>
                        {compare.includes(rev.id) ? "Tirar da comparação" : "Comparar"}
                      </button>
                    )}
                  </div>
                  {image && image.fileKey === "image" && (
                    <div className="row">
                      <button className="secondary" onClick={() => workshop(rev, image.id, "remove_background_flood")}>
                        Remover fundo
                      </button>
                      <button className="secondary" disabled={palette.length === 0} onClick={() => workshop(rev, image.id, "apply_palette")}>
                        Paleta do projeto
                      </button>
                    </div>
                  )}
                  <span className="muted small">{formatBytes(image?.bytes ?? 0)}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Exportação
// ---------------------------------------------------------------------------

function ExportPanel({ projectId, assets, exports, onChange }: { projectId: string; assets: AssetView[]; exports: ExportView[]; onChange: () => void }) {
  const approved = assets.filter((a) => a.approvedRevisionId);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);

  async function exportSelection() {
    setMessage(null);
    const revisionIds = approved.filter((a) => selected.has(a.id)).map((a) => a.approvedRevisionId!);
    try {
      const res = await apiFetch<{ export: ExportView; created: boolean }>(`/projects/${projectId}/exports`, {
        method: "POST",
        json: { revisionIds, profile: "portable-v1" },
      });
      setMessage(res.created ? "Exportação enfileirada." : "Esta seleção já foi exportada; reaproveitando o mesmo pacote.");
      onChange();
    } catch (err) {
      const problems = err instanceof ApiError ? (err.details?.problems as { message: string }[] | undefined) : undefined;
      setMessage(problems?.length ? problems.map((p) => p.message).join(" · ") : String(err instanceof Error ? err.message : err));
    }
  }

  return (
    <section>
      <h2>Exportar pacote</h2>
      <p className="muted small">Revisões ativas aprovadas; as dependências necessárias entram automaticamente.</p>
      {approved.length === 0 && <p className="muted">Aprove uma revisão para poder exportar.</p>}
      <div className="row">
        {approved.map((a) => (
          <label key={a.id} style={{ flexDirection: "row", alignItems: "center", gap: 4, color: "inherit" }}>
            <input
              type="checkbox"
              checked={selected.has(a.id)}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(a.id);
                else next.delete(a.id);
                setSelected(next);
              }}
            />
            {a.name}
          </label>
        ))}
        <button disabled={selected.size === 0} onClick={exportSelection}>
          Exportar ZIP portátil
        </button>
      </div>
      {message && <p className="small">{message}</p>}
      <ul className="list">
        {exports.map((e) => (
          <li key={e.id}>
            <div className="row">
              <span className={`badge state-${e.state === "ready" ? "succeeded" : e.state === "failed" ? "failed" : "queued"}`}>{e.state}</span>
              <span className="small">
                {e.report ? `${e.report.entries} revisões · ${e.report.files} arquivos` : `${e.revisionIds.length} selecionadas`}
                {e.bytes ? ` · ${formatBytes(e.bytes)}` : ""}
                {e.report?.addedDependencies.length ? ` · +${e.report.addedDependencies.length} dependências` : ""}
              </span>
              {e.state === "ready" && <a href={`/api/v1/projects/${projectId}/exports/${e.id}/download`}>Baixar {e.fileName}</a>}
            </div>
            {e.state === "failed" && <div className="error small">{(e.error as { message?: string } | null)?.message}</div>}
            {e.report && <div className="muted small">Limitações do perfil: {e.report.limitations.join(" · ")}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Oficina: saídas de processamento local
// ---------------------------------------------------------------------------

interface LocalRequestView {
  operation: string;
  inputs: { role: string; ref: { kind: string; revisionId?: string; fileKey?: string } }[];
}

interface LocalResultView {
  cacheHit: boolean;
  status: string;
  outputs: { index: number; role: string; key?: string; width?: number; height?: number }[];
  report: Record<string, unknown>;
  warnings: string[];
}

const PUBLISHABLE = new Set(["cutout", "paletted", "protected"]);

function LocalOutputs({ projectId, job, assetOfRevision, onChange }: { projectId: string; job: JobView; assetOfRevision: Map<string, string>; onChange: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  const request = job.request as LocalRequestView;
  const result = job.result as LocalResultView;
  const source = request.inputs[0]?.ref;

  async function publish(index: number) {
    if (source?.kind !== "revision" || !source.revisionId) return;
    const assetId = assetOfRevision.get(source.revisionId);
    if (!assetId) return setMessage("Revisão de origem não encontrada");
    setMessage(null);
    try {
      const { revision } = await apiFetch<{ revision: RevisionView }>(`/projects/${projectId}/assets/${assetId}/revisions`, {
        method: "POST",
        json: { from: "job_output", jobId: job.id, outputIndex: index, baseRevisionId: source.revisionId, fileKey: source.fileKey },
      });
      setMessage(`Revisão r${revision.number} publicada como candidata.`);
      onChange();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="small">
      <div className="muted">
        {OPERATION_LABEL[request.operation] ?? request.operation}
        {result.cacheHit ? " · reaproveitado do cache" : ""}
        {typeof result.report.removedPixels === "number" ? ` · ${result.report.removedPixels} pixels removidos` : ""}
        {typeof result.report.changedPixels === "number" ? ` · ${result.report.changedPixels} pixels ajustados` : ""}
      </div>
      {result.warnings.map((w) => (
        <div key={w} className="error">
          {w}
        </div>
      ))}
      <div className="row" style={{ marginTop: 4 }}>
        {result.outputs.map((o) => (
          <div key={o.index} className="row">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className="pixel"
              alt={o.role}
              src={`/api/v1/projects/${projectId}/jobs/${job.id}/outputs/${o.index}`}
              width={(o.width ?? 16) * (o.width && o.width <= 64 ? 4 : 1)}
              height={(o.height ?? 16) * (o.width && o.width <= 64 ? 4 : 1)}
            />
            {PUBLISHABLE.has(o.role) && source?.kind === "revision" && (
              <button className="secondary" onClick={() => publish(o.index)}>
                Publicar como revisão
              </button>
            )}
          </div>
        ))}
      </div>
      {message && <div>{message}</div>}
    </div>
  );
}

/** Cor do pixel (0,0) da imagem servida, para amostrar o fundo. */
async function sampleCorner(src: string): Promise<{ hex: string; alpha: number }> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return { hex: `#${[r, g, b].map((v) => v!.toString(16).padStart(2, "0")).join("")}`, alpha: a! };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Componentes de UI do jogo
// ---------------------------------------------------------------------------

function UiComponentsPanel({ projectId, assets, onChange }: { projectId: string; assets: AssetView[]; onChange: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("Botão de metal");
  const ui = assets.filter((a) => a.family === "ui");
  async function create(kind: "button" | "panel") {
    const { asset } = await apiFetch<{ asset: AssetView }>(`/projects/${projectId}/assets`, { method: "POST", json: { family: "ui", kind, name } });
    onChange();
    router.push(`/projects/${projectId}/ui/${asset.id}`);
  }
  return (
    <section>
      <h2>UI do jogo</h2>
      <div className="row">
        <label>
          Nome
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="secondary" onClick={() => create("button")}>
          Novo botão
        </button>
        <button className="secondary" onClick={() => create("panel")}>
          Novo painel
        </button>
      </div>
      <ul className="list">
        {ui.map((a) => (
          <li key={a.id}>
            <Link href={`/projects/${projectId}/ui/${a.id}`}>{a.name}</Link> <span className="muted small">ui/{a.kind}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
