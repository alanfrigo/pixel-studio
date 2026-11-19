"use client";

import { useState } from "react";
import type { ProviderProfileView } from "@/server/providers/registry";
import { ApiError, apiFetch } from "../client/api";
import { usePoll } from "../client/use-poll";

interface ProfileRow extends ProviderProfileView {
  capabilities: Record<string, string[]>;
  matrix: { operation: string; capability: string; status: string; contractSnapshot: string | null }[];
  unavailable: string | null;
}

type ModelField = "required" | "optional";

const TRANSPORTS: Record<
  "openrouter_images" | "codex_cli" | "openai_images",
  { label: string; base: "required" | "optional" | "none"; secret: boolean; model: ModelField; modelPlaceholder: string; idPlaceholder: string; hint?: string; example: Record<string, unknown> }
> = {
  openrouter_images: {
    label: "OpenRouter Images",
    base: "optional",
    secret: true,
    model: "required",
    modelPlaceholder: "bytedance-seed/seedream-4.5",
    idPlaceholder: "openrouter-seedream",
    example: { maxReferences: 14, transparent: false, provider: { only: ["seed"], allow_fallbacks: false } },
  },
  codex_cli: {
    label: "Codex CLI local (login do ChatGPT)",
    base: "none",
    secret: false,
    model: "optional",
    modelPlaceholder: "padrão do Codex",
    idPlaceholder: "codex-local",
    hint: "Usa o `codex` instalado nesta máquina e o login feito com `codex login`; nenhuma chave passa pelo Studio. Cada imagem é um turno do Codex que consome a cota do seu plano. O modelo, se informado, é o que conduz o turno; a imagem sai da ferramenta de imagem embutida do Codex.",
    example: { reasoningEffort: "low", maxReferences: 5, transparent: true, timeoutMs: 600000 },
  },
  openai_images: {
    label: "API customizada (contrato OpenAI Images)",
    base: "required",
    secret: true,
    model: "required",
    modelPlaceholder: "gpt-image-1",
    idPlaceholder: "api-local",
    example: { size: "1024x1024", transparent: true, maxReferences: 16 },
  },
};
type Transport = keyof typeof TRANSPORTS;


export function ProviderSettings() {
  const { data, refresh } = usePoll(() => apiFetch<{ profiles: ProfileRow[] }>("/settings/providers"), { active: () => false, slowMs: 30_000 });
  const [transport, setTransport] = useState<Transport>("openrouter_images");
  const [form, setForm] = useState({ id: "", name: "", baseUrl: "", secretRef: "", model: "", config: JSON.stringify(TRANSPORTS.openrouter_images.example, null, 2) });
  const [message, setMessage] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, string>>({});
  const spec = TRANSPORTS[transport];

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    try {
      const config = JSON.parse(form.config || "{}");
      await apiFetch("/settings/providers", {
        method: "POST",
        json: {
          id: form.id,
          name: form.name,
          transport,
          config,
          ...(spec.secret ? { secretRef: form.secretRef } : {}),
          ...(spec.base === "required" || (spec.base === "optional" && form.baseUrl) ? { baseUrl: form.baseUrl } : {}),
          ...(spec.model === "required" || form.model.trim() ? { model: form.model } : {}),
        },
      });
      setMessage("Perfil salvo. As capacidades ficam como declaradas até um ensaio as qualificar.");
      refresh();
    } catch (err) {
      const issues = err instanceof ApiError ? (err.details?.issues as { path: string[]; message: string }[] | undefined) : undefined;
      setMessage(issues?.length ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" · ") : err instanceof Error ? err.message : String(err));
    }
  }

  async function check(id: string) {
    setChecks((c) => ({ ...c, [id]: "Verificando…" }));
    const r = await apiFetch<{ ok: boolean; message: string }>(`/settings/providers/${id}/check`, { method: "POST" }).catch((e) => ({ ok: false, message: String(e.message ?? e) }));
    setChecks((c) => ({ ...c, [id]: `${r.ok ? "✓" : "✗"} ${r.message}` }));
  }

  return (
    <>
      <section>
        <h2>Perfis</h2>
        <ul className="list">
          {data?.profiles.map((p) => (
            <li key={p.id}>
              <div className="row">
                <strong>{p.name}</strong>
                <span className="muted small">
                  {p.transport} {p.model ? `· ${p.model}` : ""} {p.secretRef ? `· segredo em ${p.secretRef} (${p.secretConfigured ? "definido" : "NÃO definido"})` : ""}
                  {p.transport === "codex_cli" ? "· login local do Codex" : ""}
                </span>
                {!p.simulated && (
                  <button className="secondary" onClick={() => check(p.id)}>
                    Testar sem custo
                  </button>
                )}
              </div>
              {p.unavailable && <div className="error small">{p.unavailable}</div>}
              {checks[p.id] && <div className="small">{checks[p.id]}</div>}
              <div className="muted small">
                {Object.entries(p.capabilities)
                  .map(([op, caps]) => `${op}: ${caps.join(", ")}`)
                  .join(" · ") || "Nenhuma operação disponível"}
              </div>
              {p.matrix[0]?.contractSnapshot && <div className="muted small">Capacidades declaradas · {p.matrix[0].contractSnapshot}</div>}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>Adicionar ou atualizar perfil</h2>
        <p className="muted small">
          {spec.secret ? "O segredo nunca passa pelo navegador: informe só o nome da variável de ambiente que o servidor e o worker leem. " : ""}Nenhuma geração é feita ao salvar ou testar.
        </p>
        {spec.hint && <p className="muted small">{spec.hint}</p>}
        <form onSubmit={save}>
          <label>
            Transporte
            <select
              value={transport}
              onChange={(e) => {
                const t = e.target.value as Transport;
                setTransport(t);
                setForm((f) => ({ ...f, config: JSON.stringify(TRANSPORTS[t].example, null, 2) }));
              }}
            >
              {Object.entries(TRANSPORTS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            ID
            <input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder={spec.idPlaceholder} required />
          </label>
          <label>
            Nome
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </label>
          {spec.base !== "none" && (
            <label>
              URL base{spec.base === "required" ? "" : " (opcional)"}
              <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder={spec.base === "required" ? "http://127.0.0.1:8080/v1" : "padrão do provedor"} />
            </label>
          )}
          {spec.secret && (
            <label>
              Variável do segredo
              <input value={form.secretRef} onChange={(e) => setForm({ ...form, secretRef: e.target.value.toUpperCase() })} placeholder="OPENROUTER_API_KEY" required />
            </label>
          )}
          <label>
            Modelo{spec.model === "optional" ? " (opcional)" : ""}
            <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder={spec.modelPlaceholder} required={spec.model === "required"} />
          </label>
          <label style={{ flexBasis: "100%" }}>
            Configuração (JSON)
            <textarea value={form.config} onChange={(e) => setForm({ ...form, config: e.target.value })} rows={6} />
          </label>
          <button>Salvar perfil</button>
        </form>
        {message && <p className="small">{message}</p>}
      </section>
    </>
  );
}
