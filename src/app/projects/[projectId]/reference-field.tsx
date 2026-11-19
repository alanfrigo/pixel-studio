"use client";

import { useRef, useState } from "react";
import type { ReferenceRole } from "@/contracts";
import { apiFetch, errorMessage } from "@/app/client/api";
import { useLocale, useMessages } from "@/i18n/client";
import { workspaceMessages } from "@/i18n/messages/workspace";
import type { UploadView } from "@/server/catalog/catalog";

const ROLES: readonly ReferenceRole[] = ["identity", "style", "palette", "silhouette", "material", "pose", "equipment", "composition"];

export type ReferenceChoice = {
  key: string;
  label: string;
  source: { uploadId: string } | { revisionId: string; fileKey: string; fileId: string };
  role: ReferenceRole;
  instruction: string;
};

type SetRefs = React.Dispatch<React.SetStateAction<ReferenceChoice[]>>;

export function ReferenceField({ projectId, refs, uploads, library, setRefs, disabled, uploading, setUploading, onUpload }: {
  projectId: string;
  refs: ReferenceChoice[];
  uploads: ReadonlyMap<string, UploadView>;
  library: Omit<ReferenceChoice, "role" | "instruction">[];
  setRefs: SetRefs;
  disabled: boolean;
  uploading: boolean;
  setUploading: (uploading: boolean) => void;
  onUpload: () => void;
}) {
  const m = useMessages(workspaceMessages).generate;
  const roleLabel = useMessages(workspaceMessages).referenceRole;
  const locale = useLocale();
  const input = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const base = `/projects/${projectId}`;
  const full = refs.length >= 16;

  function append(ref: Omit<ReferenceChoice, "role" | "instruction">) {
    setRefs((previous) => previous.length >= 16 || previous.some(({ key }) => key === ref.key) ? previous : [...previous, { ...ref, role: previous.length === 0 ? "identity" : "style", instruction: "" }]);
  }

  function move(index: number, delta: number) {
    setRefs((previous) => {
      const to = index + delta;
      if (to < 0 || to >= previous.length) return previous;
      const next = [...previous];
      [next[index], next[to]] = [next[to]!, next[index]!];
      return next;
    });
  }

  async function upload(files: File[]) {
    if (!files.length) return;
    setUploadError(null);
    if (files.length + refs.length > 16) {
      setUploadError(m.referenceCap);
      return;
    }
    setUploading(true);
    const errors: string[] = [];
    try {
      for (const file of files) {
        const body = new FormData();
        body.append("file", file);
        try {
          const { upload } = await apiFetch<{ upload: UploadView }>(`${base}/uploads`, { method: "POST", body });
          if (upload.modality !== "raster") {
            errors.push(`${file.name}: ${m.referenceFileType}`);
            continue;
          }
          append({ key: upload.id, label: upload.originalName, source: { uploadId: upload.id } });
        } catch (err) {
          errors.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      setUploadError(errors.length ? errors.join(" · ") : null);
      setUploading(false);
      onUpload();
    }
  }

  const available = library.filter(({ key }) => !refs.some((ref) => ref.key === key));
  const reusable = [...uploads.values()].filter((u) => u.modality === "raster" && u.status === "ready" && u.normalizedSha256 && !refs.some((ref) => ref.key === u.id));

  return (
    <fieldset className="composer-references" disabled={disabled || uploading}>
      <legend>{m.referenceTitle} <span>{m.optional}</span></legend>
      <p className="small muted">{m.referenceDescription}</p>
      <div className="composer-reference-actions">
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden aria-label={m.uploadReferences} onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          void upload(files);
        }} />
        <button type="button" className="secondary" disabled={full} onClick={() => input.current?.click()}>
          <span aria-hidden="true">+</span> {uploading ? m.uploadingReferences : m.uploadReferences}
        </button>
        {(available.length > 0 || reusable.length > 0) && (
          <label>
            {m.fromProject}
            <select value="" disabled={full} onChange={(event) => {
              const option = available.find((ref) => ref.key === event.target.value);
              const local = reusable.find((upload) => upload.id === event.target.value);
              if (option) append(option);
              else if (local) append({ key: local.id, label: local.originalName, source: { uploadId: local.id } });
            }}>
              <option value="">{m.fromLibrary}</option>
              {reusable.length > 0 && <optgroup label={m.uploadedReferences}>{reusable.map((upload) => <option key={upload.id} value={upload.id}>{upload.originalName}</option>)}</optgroup>}
              {available.length > 0 && <optgroup label={m.approvedReferences}>{available.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}</optgroup>}
            </select>
          </label>
        )}
      </div>
      {full && <p className="small muted">{m.referenceCap}</p>}
      {uploadError && <p className="error small" role="alert">{uploadError}</p>}
      {refs.length > 0 && (
        <ol className="composer-reference-list">
          {refs.map((ref, index) => {
            const upload = "uploadId" in ref.source ? uploads.get(ref.source.uploadId) : undefined;
            const mediaId = "uploadId" in ref.source ? upload?.status === "ready" && upload.normalizedSha256 ? upload.id : null : ref.source.fileId;
            return (
              <li key={ref.key}>
                <div className="composer-reference-row">
                  <div className="composer-reference-thumb">
                    {mediaId ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img alt="" src={`/api/v1${base}/media/${mediaId}`} width={48} height={48} />
                    ) : <span aria-hidden="true">{index + 1}</span>}
                  </div>
                  <div className="composer-reference-info">
                    <strong>{ref.label}</strong>
                    {!mediaId && <span role="status" className={upload?.status === "rejected" ? "error small" : "muted small"}>
                      {upload?.status === "rejected" ? errorMessage(upload.error, locale) ?? m.referenceRejected : m.processingReference}
                    </span>}
                  </div>
                  <label className="composer-reference-role">
                    {m.referenceUse}
                    <select aria-label={m.imageRole(index + 1)} value={ref.role} onChange={(event) => {
                      const role = event.target.value as ReferenceRole;
                      setRefs((previous) => previous.map((r) => r.key === ref.key ? { ...r, role } : r));
                    }}>
                      {ROLES.map((role) => <option key={role} value={role}>{roleLabel[role]}</option>)}
                    </select>
                  </label>
                  <button type="button" className="secondary composer-reference-remove" aria-label={`${m.remove}: ${ref.label}`} onClick={() => setRefs((previous) => previous.filter(({ key }) => key !== ref.key))}>×</button>
                </div>
                <details className="composer-reference-detail">
                  <summary>{m.referenceDetails}</summary>
                  <div className="row">
                    <label>
                      {m.imageInstruction(index + 1)}
                      <input value={ref.instruction} placeholder={m.instructionPlaceholder} maxLength={300} onChange={(event) => {
                        const instruction = event.target.value;
                        setRefs((previous) => previous.map((r) => r.key === ref.key ? { ...r, instruction } : r));
                      }} />
                    </label>
                    {refs.length > 1 && <>
                      <button type="button" className="secondary" aria-label={m.moveUp} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
                      <button type="button" className="secondary" aria-label={m.moveDown} disabled={index === refs.length - 1} onClick={() => move(index, 1)}>↓</button>
                    </>}
                  </div>
                </details>
              </li>
            );
          })}
        </ol>
      )}
    </fieldset>
  );
}
