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

const TRANSPORTS = {
  openrouter_images: { label: "OpenRouter Images", needsBase: false, needsModel: true, example: { maxReferences: 14, transparent: false, provider: { only: ["seed"], allow_fallbacks: false } } },
  pixellab_rest_v2: { label: "PixelLab REST v2", needsBase: false, needsModel: false, example: { pollIntervalMs: 5000 } },
  openai_images: { label: "API customizada (contrato OpenAI Images)", needsBase: true, needsModel: true, example: { size: "1024x1024", transparent: true, maxReferences: 16 } },
} as const;
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
          secretRef: form.secretRef,
          config,
          ...(spec.needsBase || form.baseUrl ? { baseUrl: form.baseUrl } : {}),
          ...(spec.needsModel ? { model: form.model } : {}),
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
          O segredo nunca passa pelo navegador: informe só o nome da variável de ambiente que o servidor e o worker leem. Nenhuma geração é feita ao salvar ou testar.
        </p>
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
            <input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="openrouter-seedream" required />
          </label>
          <label>
            Nome
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </label>
          <label>
            URL base{spec.needsBase ? "" : " (opcional)"}
            <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder={spec.needsBase ? "http://127.0.0.1:8080/v1" : "padrão do provedor"} />
          </label>
          <label>
            Variável do segredo
            <input value={form.secretRef} onChange={(e) => setForm({ ...form, secretRef: e.target.value.toUpperCase() })} placeholder="OPENROUTER_API_KEY" required />
          </label>
          {spec.needsModel && (
            <label>
              Modelo
              <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="bytedance-seed/seedream-4.5" required />
            </label>
          )}
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
