import { Base, describe } from "./model.js";
import type { Payload } from "./model.js";
export class Endpoint extends Base implements Payload {
  value = "café";
  handle(input: Payload): string { return describe(input.value); }
}
export function uncertain(input: unknown) {
  return (input as { run(): string }).run();
}
throw new Error("RESOLVER_TS_FIXTURE_MUST_NOT_EXECUTE");
