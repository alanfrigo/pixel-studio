import type { GenerationPlan } from "@/contracts";
import { tx } from "@/i18n/locales";
import { DomainFailure } from "../errors";
import type { ProviderAdapter } from "./types";

export function assetReferenceLimits(adapter: ProviderAdapter, profileId: string, requested: number) {
  const limits = adapter.limits?.("generate_asset");
  const maxReferences = limits?.maxReferences;
  if (maxReferences !== undefined && requested > maxReferences) {
    throw new DomainFailure("capability_missing", tx(`O perfil ${profileId} aceita até ${maxReferences} referência(s); o pedido tem ${requested}`, `Provider profile ${profileId} accepts up to ${maxReferences} reference(s); the request has ${requested}`), { maxReferences, requested });
  }
  return limits;
}

export function assertPlanCapabilities(adapter: ProviderAdapter, plan: GenerationPlan): void {
  const capabilities = adapter.capabilities(plan.operation);
  const missing = plan.requiredCapabilities.filter((capability) => !capabilities.includes(capability));
  if (missing.length > 0) {
    throw new DomainFailure("capability_missing", tx(`O perfil ${plan.providerProfileId} não oferece: ${missing.join(", ")}`, `Provider profile ${plan.providerProfileId} does not offer: ${missing.join(", ")}`), { missing });
  }
  if (plan.operation === "generate_asset") {
    const requested = plan.sources.length;
    const alphaReferences = assetReferenceLimits(adapter, plan.providerProfileId, requested)?.alphaReferences;
    if (plan.requiredCapabilities.includes("alpha_output") && alphaReferences !== undefined && alphaReferences !== requested) {
      throw new DomainFailure("capability_missing", tx(`O perfil ${plan.providerProfileId} só oferece alfa nativo com ${alphaReferences} referência(s)`, `Provider profile ${plan.providerProfileId} only offers native alpha with ${alphaReferences} reference(s)`), { alphaReferences, requested });
    }
  }
}
