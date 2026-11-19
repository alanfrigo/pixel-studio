import type { AssetFamily, GenerationPlan } from "@/contracts";

/**
 * Validação de referências de um plano contra o catálogo (02a): toda revisão
 * citada existe, pertence ao mesmo projeto, fontes estão aprovadas e os hashes
 * congelados conferem com os arquivos vinculados. A máscara é um upload do
 * projeto com a mesma grade da fonte.
 */

export interface CatalogFile {
  sha256: string;
  width?: number;
  height?: number;
}

export interface CatalogRevision {
  revisionId: string;
  projectId: string;
  family: AssetFamily | "style" | "preset";
  kind: string;
  status: "candidate" | "approved" | "rejected" | "archived";
  files: Record<string, CatalogFile>;
  /** Digest canônico do payload tipado (revisões sem arquivo). */
  payloadDigest?: string;
}

export interface CatalogUpload extends CatalogFile {
  fileId: string;
  projectId: string;
}

export interface PlanLookup {
  revision(revisionId: string): CatalogRevision | undefined;
  upload(fileId: string): CatalogUpload | undefined;
}

export type PlanIssueCode =
  | "not_found"
  | "cross_project_reference"
  | "source_not_approved"
  | "source_file_mismatch"
  | "wrong_reference_kind"
  | "mask_size_mismatch";

export interface PlanIssue {
  code: PlanIssueCode;
  message: string;
  path: (string | number)[];
  revisionId?: string;
}

interface ParamRef {
  revisionId: string;
  path: (string | number)[];
  family?: CatalogRevision["family"];
}

/** Revisões citadas nos parâmetros (além de estilo e fontes). */
export function planParamRefs(plan: GenerationPlan): ParamRef[] {
  const refs: ParamRef[] = [];
  const add = (revisionId: string | null | undefined, path: (string | number)[], family?: ParamRef["family"]) => {
    if (revisionId) refs.push({ revisionId, path: ["params", ...path], ...(family ? { family } : {}) });
  };
  switch (plan.operation) {
    case "animate_preset":
      add(plan.params.presetRevisionId, ["presetRevisionId"], "preset");
      add(plan.params.baseRevisionId, ["baseRevisionId"], "character");
      break;
    case "animate_text":
      add(plan.params.baseRevisionId, ["baseRevisionId"], "character");
      add(plan.params.startFrame?.clipRevisionId, ["startFrame", "clipRevisionId"], "character");
      add(plan.params.endFrame?.clipRevisionId, ["endFrame", "clipRevisionId"], "character");
      break;
    case "animate_skeleton":
      add(plan.params.baseRevisionId, ["baseRevisionId"], "character");
      add(plan.params.motionRevisionId, ["motionRevisionId"], "character");
      break;
    case "rotate_views":
      add(plan.params.identityRevisionId, ["identityRevisionId"]);
      break;
    case "inpaint":
      add(plan.params.sourceRevisionId, ["sourceRevisionId"]);
      break;
    case "create_state":
      add(plan.params.baseRevisionId, ["baseRevisionId"]);
      add(plan.params.predecessorStateRevisionId, ["predecessorStateRevisionId"]);
      break;
    case "generate_room":
      add(plan.params.styleRoomRevisionId, ["styleRoomRevisionId"]);
      break;
    case "generate_ui_states":
      plan.params.componentRevisionIds.forEach((id, i) => add(id, ["componentRevisionIds", i], "ui"));
      break;
    case "generate_portrait":
      add(plan.params.characterRevisionId, ["characterRevisionId"], "character");
      break;
    case "generate_visemes":
      add(plan.params.portraitRevisionId, ["portraitRevisionId"], "portrait");
      break;
    default:
      break;
  }
  return refs;
}

export function validatePlanReferences(plan: GenerationPlan, lookup: PlanLookup): PlanIssue[] {
  const issues: PlanIssue[] = [];

  const resolve = (revisionId: string, path: (string | number)[], opts: { approved: boolean; family?: ParamRef["family"] }) => {
    const rev = lookup.revision(revisionId);
    if (!rev) {
      issues.push({ code: "not_found", message: `Revisão inexistente: ${revisionId}`, path, revisionId });
      return undefined;
    }
    if (rev.projectId !== plan.projectId) {
      // Mesma resposta de "não encontrado" para o cliente (404), código distinto para diagnóstico.
      issues.push({ code: "cross_project_reference", message: `Revisão ${revisionId} pertence a outro projeto`, path, revisionId });
      return undefined;
    }
    if (opts.family && rev.family !== opts.family) {
      issues.push({ code: "wrong_reference_kind", message: `${revisionId} é ${rev.family}; esperado ${opts.family}`, path, revisionId });
    }
    if (opts.approved && rev.status !== "approved") {
      issues.push({ code: "source_not_approved", message: `Revisão ${revisionId} não está aprovada (${rev.status})`, path, revisionId });
    }
    return rev;
  };

  resolve(plan.styleRevisionId, ["styleRevisionId"], { approved: true, family: "style" });

  plan.sources.forEach((source, i) => {
    const path = ["sources", i];
    if (source.role === "edit_mask") {
      const upload = source.fileId === null ? undefined : lookup.upload(source.fileId);
      if (!upload) {
        issues.push({ code: "not_found", message: `Máscara inexistente: ${source.fileId}`, path });
      } else if (upload.projectId !== plan.projectId) {
        issues.push({ code: "cross_project_reference", message: `Máscara ${source.fileId} pertence a outro projeto`, path });
      } else if (upload.sha256 !== source.sha256) {
        issues.push({ code: "source_file_mismatch", message: `Hash congelado da máscara diverge do upload`, path });
      }
      return;
    }
    const rev = resolve(source.revisionId, [...path, "revisionId"], { approved: true });
    if (!rev) return;
    if (source.fileId === null) {
      if (rev.payloadDigest !== source.sha256) {
        issues.push({ code: "source_file_mismatch", message: `Digest congelado de ${source.revisionId} diverge do payload`, path, revisionId: source.revisionId });
      }
      return;
    }
    const file = rev.files[source.fileId];
    if (!file) {
      issues.push({ code: "source_file_mismatch", message: `${source.fileId} não pertence a ${source.revisionId}`, path, revisionId: source.revisionId });
    } else if (file.sha256 !== source.sha256) {
      issues.push({ code: "source_file_mismatch", message: `Hash congelado de ${source.fileId} diverge da revisão`, path, revisionId: source.revisionId });
    }
  });

  for (const ref of planParamRefs(plan)) {
    resolve(ref.revisionId, ref.path, { approved: true, ...(ref.family ? { family: ref.family } : {}) });
  }

  if (plan.operation === "inpaint") {
    const source = lookup.revision(plan.params.sourceRevisionId)?.files[plan.params.sourceFileId];
    const mask = lookup.upload(plan.params.editMaskFileId);
    if (source && mask && (source.width !== mask.width || source.height !== mask.height)) {
      issues.push({
        code: "mask_size_mismatch",
        message: `Máscara ${mask.width}×${mask.height} difere da fonte ${source.width}×${source.height}`,
        path: ["params", "editMaskFileId"],
      });
    }
    const [w, h] = plan.params.logicalSize;
    if (source && (source.width !== w || source.height !== h)) {
      issues.push({ code: "mask_size_mismatch", message: `Tamanho lógico ${w}×${h} difere da fonte`, path: ["params", "logicalSize"] });
    }
  }

  return issues;
}
