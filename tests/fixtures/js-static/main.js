import { Base, decorate } from "./base.js";
throw new Error("FIXTURE_MUST_NOT_EXECUTE");
export class Widget extends Base {
  label = "contoh";
  render() { return decorate(this.label); }
}
export function loadDynamic(name) { return import(name); }
