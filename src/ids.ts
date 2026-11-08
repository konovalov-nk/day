import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";

export const PREFIX = {
  goal: "G",
  criterion: "GC",
  task: "T",
  event: "E",
  session: "S",
  rule: "R",
  progress: "P",
  note: "N",
  experiment: "X",
  attribution: "A",
  observation: "O",
  suggestion: "U",
  evaluation: "V",
  conclusion: "CN",
} as const;

export type RefKind = keyof typeof PREFIX;

export function display(kind: RefKind, id: number): string {
  return `${PREFIX[kind]}${String(id).padStart(2, "0")}`;
}

export function parseRef(value: string, kind: RefKind): number {
  const prefix = PREFIX[kind];
  const match = new RegExp(`^${prefix}(\\d+)$`, "i").exec(value.trim());
  if (!match?.[1]) {
    throw new AppError(
      "invalid_reference",
      `Expected a ${kind} reference such as ${display(kind, 1)}. Got: ${value}`,
    );
  }
  return Number(match[1]);
}

export function operationId(value?: string): string {
  return value ?? `op_${randomUUID()}`;
}

export function shortHash(value: string, length = 12): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, length);
}
