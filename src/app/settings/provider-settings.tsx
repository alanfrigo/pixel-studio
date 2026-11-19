"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderProfileView } from "@/server/providers/registry";
import { useMessages, useText } from "@/i18n/client";
import type { TextValue } from "@/i18n/locales";
import { homeMessages } from "@/i18n/messages/home";
import { ApiError, apiFetch } from "../client/api";
import { settingsMessages } from "./messages";
import styles from "./settings.module.css";

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
    modelPlaceholder: "openai/gpt-image-1-mini",
    idPlaceholder: "openrouter-mini",
    example: {},
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

type Check = { ok: boolean; message: TextValue };

function isTransport(value: string): value is Transport {
  return Object.hasOwn(TRANSPORTS, value);
}

function newForm(transport: Transport) {
  return { id: "", name: "", baseUrl: "", secretRef: "", model: "", config: JSON.stringify(TRANSPORTS[transport].example, null, 2) };
}

async function checkProfile(id: string, signal?: AbortSignal): Promise<Check> {
  try {
    return await apiFetch<Check>(`/settings/providers/${encodeURIComponent(id)}/check`, { method: "POST", signal });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function ProviderSettings() {
  const m = useMessages(homeMessages).settings;
  const s = useMessages(settingsMessages);
  const text = useText();
  const [profiles, setProfiles] = useState<ProfileRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [transport, setTransport] = useState<Transport>("codex_cli");
  const [form, setForm] = useState(() => newForm("codex_cli"));
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [codexChecks, setCodexChecks] = useState<Record<string, Check>>({});
  const [manualChecks, setManualChecks] = useState<Record<string, Check | "pending">>({});
  const refreshController = useRef<AbortController | null>(null);
  const spec = TRANSPORTS[transport];

  const loadStatus = useCallback(async () => {
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    const signal = controller.signal;
    try {
      const { profiles } = await apiFetch<{ profiles: ProfileRow[] }>("/settings/providers", { signal });
      if (signal.aborted) return;
      setProfiles(profiles);
      const results = await Promise.all(profiles.filter((p) => p.transport === "codex_cli").map(async (p) => [p.id, await checkProfile(p.id, signal)] as const));
      if (!signal.aborted) setCodexChecks(Object.fromEntries(results));
    } catch (error) {
      if (!signal.aborted) setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // The Strict Mode probe unmounts before the timer, so it never starts a duplicate check.
    const kickoff = window.setTimeout(() => void loadStatus(), 0);
    return () => {
      window.clearTimeout(kickoff);
      refreshController.current?.abort();
    };
  }, [loadStatus]);

  function refresh() {
    setLoading(true);
    setLoadError(null);
    void loadStatus();
  }

  function selectForm(t: Transport, p?: ProfileRow) {
    setTransport(t);
    setMessage(null);
    setEditing(!!p);
    setForm(p ? {
      id: p.id, name: p.name, baseUrl: p.baseUrl ?? "", secretRef: p.secretRef ?? "",
      model: p.model ?? "", config: JSON.stringify(p.config, null, 2),
    } : newForm(t));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    setSaving(true);
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
      setManualChecks((checks) => {
        if (!Object.hasOwn(checks, form.id)) return checks;
        const remaining = { ...checks };
        delete remaining[form.id];
        return remaining;
      });
      void refresh();
    } catch (err) {
      const issues = err instanceof ApiError ? (err.details?.issues as { path: string[]; message: string }[] | undefined) : undefined;
      setMessage(issues?.length ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" · ") : err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function check(id: string) {
    setManualChecks((c) => ({ ...c, [id]: "pending" }));
    const result = await checkProfile(id);
    setManualChecks((c) => c[id] === "pending" ? { ...c, [id]: result } : c);
  }

  function renderProfile(p: ProfileRow, codex: boolean) {
    const t = p.transport;
    const result = codex ? codexChecks[p.id] : manualChecks[p.id];
    const profileStatus = codex
      ? loading ? m.checking : loadError ? s.unavailable : result && result !== "pending" && result.ok ? s.ready : s.needsAttention
      : p.unavailable ? s.unavailable : p.simulated ? s.offline : s.available;
    return (
      <li className={styles.profile} key={p.id}>
        <div className={styles.profileHeading}>
          <div>
            <strong>{p.name}</strong>
            <p className="small muted">
              {isTransport(t) ? m.transports[t] : p.simulated ? s.offline : t}
              {p.model ? ` · ${p.model}` : codex ? ` · ${m.codexModelPlaceholder}` : ""}
              {p.secretRef ? ` ${m.secretIn(p.secretRef, p.secretConfigured)}` : ""}
            </p>
          </div>
          <span className={styles.status} data-ready={codex && !loading && !loadError && result !== "pending" && result?.ok ? "true" : undefined}>{profileStatus}</span>
        </div>
        {!codex && p.unavailable && <p className="small error">{text(p.unavailable)}</p>}
        {(!codex || (!loading && !loadError)) && result && (
          <p role="status" className={result !== "pending" && !result.ok ? "small error" : "small muted"}>
            {result === "pending" ? m.checking : text(result.message)}
          </p>
        )}
        <div className={styles.actions}>
          {isTransport(t) && (
            <a className="button secondary" href="#profile-editor" aria-disabled={saving || undefined} onClick={(event) => {
              if (saving) event.preventDefault();
              else selectForm(t, p);
            }}>
              {s.edit}
            </a>
          )}
          {!codex && !p.simulated && (
            <button type="button" className="secondary" disabled={result === "pending" || saving} onClick={() => void check(p.id)}>
              {m.testFree}
            </button>
          )}
        </div>
        <details className={styles.disclosure}>
          <summary>{m.declaredCapabilities}</summary>
          {Object.keys(p.capabilities).length ? (
            <dl className={styles.capabilities}>
              {Object.entries(p.capabilities).map(([op, caps]) => (
                <div key={op}><dt>{op}</dt><dd>{caps.join(", ")}</dd></div>
              ))}
            </dl>
          ) : <p className="small muted">{m.noOperations}</p>}
          {p.matrix[0]?.contractSnapshot && <p className="small muted">{text(p.matrix[0].contractSnapshot)}</p>}
        </details>
      </li>
    );
  }

  const codexProfiles = profiles?.filter((p) => p.transport === "codex_cli");
  const otherProfiles = profiles?.filter((p) => p.transport !== "codex_cli");
  return (
    <>
      <section className={styles.connection} aria-labelledby="codex-connection">
        <div className={styles.connectionHeading}>
          <div>
            <h2 id="codex-connection">{s.codexTitle}</h2>
            <p className="muted">{s.codexChecks}</p>
          </div>
          <button type="button" className="secondary" disabled={loading || saving} onClick={() => void refresh()}>{s.refresh}</button>
        </div>
        {loadError && <p role="alert" className="error">{s.profileLoadFailed} {loadError}</p>}
        {loading && <p role="status" className="small muted">{m.checking}</p>}
        {codexProfiles?.length ? (
          <>
            <ul className={styles.profiles}>{codexProfiles.map((p) => renderProfile(p, true))}</ul>
            {!loading && !loadError && codexProfiles.some((p) => codexChecks[p.id]?.ok === false) && (
              <p className="small muted">{s.signIn} <code>codex login</code> {s.thenRefresh}</p>
            )}
          </>
        ) : !loading && !loadError ? (
          <div className={styles.notConfigured}>
            <strong>{s.notConfigured}</strong>
            <p className="small muted">{s.install} <code>codex login</code> {s.thenSave}</p>
            <a className="button" href="#profile-editor" aria-disabled={saving || undefined} onClick={(event) => {
              if (saving) event.preventDefault();
              else if (transport !== "codex_cli" || editing) selectForm("codex_cli");
            }}>{s.configure}</a>
          </div>
        ) : null}
      </section>
      {!!otherProfiles?.length && (
        <section aria-labelledby="provider-profiles">
          <h2 id="provider-profiles">{m.profiles}</h2>
          <ul className={styles.profiles}>{otherProfiles.map((p) => renderProfile(p, false))}</ul>
        </section>
      )}
      <section id="profile-editor" tabIndex={-1} aria-labelledby="profile-editor-title">
        <div className={styles.connectionHeading}>
          <h2 id="profile-editor-title">{m.addOrUpdate}</h2>
          {editing && <button type="button" className="secondary" disabled={saving} onClick={() => selectForm(transport)}>{s.newProfile}</button>}
        </div>
        <p className="muted small">
          {spec.secret ? m.secretNote : ""}
          {m.noGeneration}
        </p>
        {spec.hint && <p className="muted small">{m.codexHint}</p>}
        <form onSubmit={save} className={styles.form} aria-busy={saving}>
          <label>
            {m.transport}
            <select
              value={transport}
              disabled={saving}
              onChange={(e) => {
                const t = e.target.value as Transport;
                setTransport(t);
                setForm((f) => ({ ...f, baseUrl: "", secretRef: "", model: "", config: JSON.stringify(TRANSPORTS[t].example, null, 2) }));
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
            <input value={form.id} readOnly={editing} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder={spec.idPlaceholder} required />
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
              <input value={form.secretRef} onChange={(e) => setForm({ ...form, secretRef: e.target.value.toUpperCase() })} placeholder={transport === "openai_images" ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY"} required />
            </label>
          )}
          <label>
            {m.model}
            {spec.model === "optional" ? m.optional : ""}
            <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder={spec.modelPlaceholder ?? m.codexModelPlaceholder} required={spec.model === "required"} />
          </label>
          <details className={styles.formAdvanced}>
            <summary>{s.advanced}</summary>
            <label>
              {m.config}
              <textarea value={form.config} onChange={(e) => setForm({ ...form, config: e.target.value })} rows={6} />
            </label>
          </details>
          <button type="submit" className="button" disabled={saving}>{m.saveProfile}</button>
        </form>
        {message && <p role="status" className="small">{message}</p>}
      </section>
    </>
  );
}
