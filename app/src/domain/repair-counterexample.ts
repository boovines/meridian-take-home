import { z } from "zod";
import { DomainError } from "./errors";
import type { Json } from "./runtime";

// These are model-authored hypotheses, never trusted evaluation cases.
export const counterexampleInput = z.object({
  rationale: z.string().min(1).max(1000),
  changes: z.array(z.object({
    path: z.array(z.string().min(1).max(200)).min(2).max(20),
    value: z.json(),
  }).strict()).min(1).max(8),
  expectations: z.array(z.object({
    path: z.array(z.string().min(1).max(200)).max(20),
    expected: z.json(),
  }).strict()).min(1).max(8),
}).strict();

export function applyCounterexample(context: Record<string, Json>, probe: z.infer<typeof counterexampleInput>): Record<string, Json> {
  if (new TextEncoder().encode(JSON.stringify(probe)).byteLength > 50_000)
    throw new DomainError(422,"COUNTEREXAMPLE_TOO_LARGE","A diagnostic input variation must fit within 50 KB.");
  const copy = structuredClone(context);
  for (const {path,value} of probe.changes) {
    if (!["input","steps"].includes(path[0]) || path.some(key=>["__proto__","prototype","constructor"].includes(key)))
      throw new DomainError(422,"COUNTEREXAMPLE_PATH","Vary existing input or predecessor-output fields only.");
    let parent: Json = copy;
    for (let index=0; index<path.length; index++) {
      const key = path[index];
      if (!parent || typeof parent!=="object" || !Object.hasOwn(parent,key) ||
        (Array.isArray(parent) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key)>=parent.length)))
        throw new DomainError(422,"COUNTEREXAMPLE_PATH","The diagnostic change must reference an existing field or array entry.");
      if (index===path.length-1) (parent as Record<string,Json>)[key]=structuredClone(value) as Json;
      else parent=(parent as Record<string,Json>)[key];
    }
  }
  return copy;
}
