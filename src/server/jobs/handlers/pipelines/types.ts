import type { GenerationPlan } from "@/contracts";
import type { AssetView } from "../../../catalog/catalog";
import type { Db } from "../../../db/connection";
import type { ProviderAdapter } from "../../../providers/types";
import type { StoredBlob } from "../../../storage/blob-store";
import type { HandlerContext } from "../../context";
import type { PartRow } from "../../queue";
import type { PipelineEnv, ProcessedPart } from "./shared";

export interface ProcessResult {
  processed: ProcessedPart;
  /** Imagem principal do resultado (registrada como blob raster). */
  stored: StoredBlob;
  /** Outros PNGs produzidos (candidato, frames, guias), registrados junto. */
  extraBlobs?: { blob: StoredBlob; width: number; height: number }[];
}

/**
 * Como uma operação do plano (que não seja `generate_asset`) prepara o envio,
 * processa cada imagem recebida e publica revisões. Registrar em `./index.ts`.
 *
 * O fluxo de fila, envio, retomada, cobrança e fencing continua no handler de
 * geração: o pipeline só cuida do que é próprio da operação.
 */
export interface OperationPipeline {
  /** Web (antes de enfileirar) e worker (antes de cobrar): o asset alvo combina com o plano? Lança DomainFailure. */
  validateTarget(input: { db: Db; projectId: string; plan: GenerationPlan; asset: AssetView }): void;
  /** Referências em bytes, na ordem e codificação que o adaptador espera. */
  loadInputs(ctx: HandlerContext, plan: GenerationPlan, adapter: ProviderAdapter): Promise<{ role: string; mime: string; bytes: Uint8Array }[]>;
  /** Uma imagem recebida → resultado local (idempotente, sem tocar o banco). */
  process(env: PipelineEnv, plan: GenerationPlan, sha256: string, dir: string): Promise<ProcessResult>;
  /** Dentro da transação de conclusão: publica revisões a partir das linhas processadas da parte. */
  publish(ctx: HandlerContext, plan: GenerationPlan, asset: AssetView, part: PartRow, perPart: number): string[];
}
