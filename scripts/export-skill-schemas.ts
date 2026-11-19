import { z } from "zod";
import { PythonRequest } from "@/contracts";
import { LocalOperation } from "@/server/jobs/context";
import { PLAN_BUILDERS } from "@/server/plan-builders";

// Export the HTTP preview inputs, not the frozen GenerationPlan sent to a job.
const plans = Object.fromEntries(PLAN_BUILDERS.map(({ operation, input }) => [operation, z.toJSONSchema(input, { io: "input" })]));
const localRecipes = Object.fromEntries(LocalOperation.options.map((operation) => {
  const contract = PythonRequest.options.find((option) => option.shape.operation.value === operation);
  if (!contract) throw new Error(`Missing recipe contract for ${operation}`);
  return [operation, z.toJSONSchema(contract.shape.recipe, { io: "input" })];
}));

console.log(JSON.stringify({ plans, localRecipes }, null, 2));
