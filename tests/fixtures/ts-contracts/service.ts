import { Base, type Identifiable } from "./models.js";
export class Service extends Base implements Identifiable {
  label = "layanan";
  describe(): string { return this.label; }
}
export function callUnknown(receiver: unknown): unknown {
  return (receiver as { run: () => unknown }).run();
}
