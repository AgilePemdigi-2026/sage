import { RecordNode } from "./model-node.js";
export function createRecord(): RecordNode {
  return new RecordNode();
}
export function updateLocalRecord(value: string): string {
  const local = new RecordNode();
  local.label = value;
  return local.label;
}
