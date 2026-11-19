import { z } from "zod";
import { GenerationPlan } from "./generation-plan";
import { Manifest } from "./manifest";
import { PythonRequest, PythonResponse } from "./python-protocol";
import { StylePayload } from "./style";

const SCHEMAS = {
  "manifest.schema.json": Manifest,
  "generation-plan.schema.json": GenerationPlan,
  "style.schema.json": StylePayload,
  "python-request.schema.json": PythonRequest,
  "python-response.schema.json": PythonResponse,
} as const;

export function jsonSchemaFiles(): { name: string; content: string }[] {
  return Object.entries(SCHEMAS).map(([name, schema]) => {
    const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", reused: "ref" });
    return { name, content: `${JSON.stringify({ $id: `pixel-studio/v1/${name}`, ...json }, null, 2)}\n` };
  });
}
