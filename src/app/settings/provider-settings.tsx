"use client";

import { useState } from "react";
import type { ProviderProfileView } from "@/server/providers/registry";
import { useMessages, useText } from "@/i18n/client";
import type { TextValue } from "@/i18n/locales";
import { homeMessages } from "@/i18n/messages/home";
import { ApiError, apiFetch } from "../client/api";
import { usePoll } from "../client/use-poll";

interface ProfileRow extends ProviderProfileView {
  capabilities: Record<string, string[]>;
  matrix: { operation: string; capability: string; status: string; contractSnapshot: TextValue | null }[];
  unavailable: TextValue | null;
}

type ModelField = "required" | "optional";

const TRANSPORTS: Record<
  "openrouter_images" | "codex_cli" | "openai_images",
  { base: "required" | "optional" | "none"; secret: boolean; model: ModelField; modelPlaceholder: string | null; idPlaceholder: string; hint?: boolean; example: Record<string, unknown> }
> = {
  openrouter_images: {
    base: "optional",
    secret: true,
    model: "required",
    modelPlaceholder: "bytedance-seed/seedream-4.5",
    idPlaceholder: "openrouter-seedream",
    example: { maxReferences: 14, transparent: false, provider: { only: ["seed"], allow_fallbacks: false } },
  },
  codex_cli: {
    base: "none",
    secret: false,
    model: "optional",
    // Sem modelo fixo: o texto do campo vem do catálogo (padrão do Codex).
    modelPlaceholder: null,
    idPlaceholder: "codex-local",
    hint: true,
    example: { reasoningEffort: "low", maxReferences: 5, transparent: true, timeoutMs: 600000 },
  },
  openai_images: {
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
  const m = useMessages(homeMessages).settings;
  const text = useText();
  const { data, refresh } = usePoll(() => apiFetch<{ profiles: ProfileRow[] }>("/settings/providers"), { active: () => false, slowMs: 30_000 });
  const [transport, setTransport] = useState<Transport>("openrouter_images");
  const [form, setForm] = useState({ id: "", name: "", baseUrl: "", secretRef: "", model: "", config: JSON.stringify(TRANSPORTS.openrouter_images.example, null, 2) });
  const [message, setMessage] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, { pending: true } | { ok: boolean; message: TextValue }>>({});
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
      setMessage(m.saved);
      refresh();
    } catch (err) {
      const issues = err instanceof ApiError ? (err.details?.issues as { path: string[]; message: string }[] | undefined) : undefined;
      setMessage(issues?.length ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" · ") : err instanceof Error ? err.message : String(err));
    }
  }

  async function check(id: string) {
    setChecks((c) => ({ ...c, [id]: { pending: true } }));
    const r = await apiFetch<{ ok: boolean; message: TextValue }>(`/settings/providers/${id}/check`, { method: "POST" }).catch((e) => ({ ok: false, message: String(e.message ?? e) }));
    setChecks((c) => ({ ...c, [id]: r }));
  }

  const checkText = (c: { pending: true } | { ok: boolean; message: TextValue }) => ("pending" in c ? m.checking : `${c.ok ? "✓" : "✗"} ${text(c.message)}`);

  return (
    <>
      <section>
        <h2>{m.profiles}</h2>
        <ul className="list">
          {data?.profiles.map((p) => (
            <li key={p.id}>
              <div className="row">
                <strong>{p.name}</strong>
                <span className="muted small">
                  {p.transport} {p.model ? `· ${p.model}` : ""} {p.secretRef ? m.secretIn(p.secretRef, p.secretConfigured) : ""}
                  {p.transport === "codex_cli" ? m.codexLogin : ""}
                </span>
                {!p.simulated && (
                  <button className="secondary" onClick={() => check(p.id)}>
                    {m.testFree}
                  </button>
                )}
              </div>
              {p.unavailable && <div className="error small">{text(p.unavailable)}</div>}
              {checks[p.id] && <div className="small">{checkText(checks[p.id]!)}</div>}
              <div className="muted small">
                {Object.entries(p.capabilities)
                  .map(([op, caps]) => `${op}: ${caps.join(", ")}`)
                  .join(" · ") || m.noOperations}
              </div>
              {p.matrix[0]?.contractSnapshot && <div className="muted small">
                  {m.declaredCapabilities} · {text(p.matrix[0].contractSnapshot)}
                </div>}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>{m.addOrUpdate}</h2>
        <p className="muted small">
          {spec.secret ? m.secretNote : ""}
          {m.noGeneration}
        </p>
        {spec.hint && <p className="muted small">{m.codexHint}</p>}
        <form onSubmit={save}>
          <label>
            {m.transport}
            <select
              value={transport}
              onChange={(e) => {
                const t = e.target.value as Transport;
                setTransport(t);
                setForm((f) => ({ ...f, config: JSON.stringify(TRANSPORTS[t].example, null, 2) }));
              }}
            >
              {Object.keys(TRANSPORTS).map((k) => (
                <option key={k} value={k}>
                  {m.transports[k as Transport]}
                </option>
              ))}
            </select>
          </label>
          <label>
            {m.id}
            <input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder={spec.idPlaceholder} required />
          </label>
          <label>
            {m.name}
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </label>
          {spec.base !== "none" && (
            <label>
              {m.baseUrl}
              {spec.base === "required" ? "" : m.optional}
              <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder={spec.base === "required" ? "http://127.0.0.1:8080/v1" : m.providerDefault} />
            </label>
          )}
          {spec.secret && (
            <label>
              {m.secretVariable}
              <input value={form.secretRef} onChange={(e) => setForm({ ...form, secretRef: e.target.value.toUpperCase() })} placeholder="OPENROUTER_API_KEY" required />
            </label>
          )}
          <label>
            {m.model}
            {spec.model === "optional" ? m.optional : ""}
            <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder={spec.modelPlaceholder ?? m.codexModelPlaceholder} required={spec.model === "required"} />
          </label>
          <label style={{ flexBasis: "100%" }}>
            {m.config}
            <textarea value={form.config} onChange={(e) => setForm({ ...form, config: e.target.value })} rows={6} />
          </label>
          <button>{m.saveProfile}</button>
        </form>
        {message && <p className="small">{message}</p>}
      </section>
    </>
  );
}
