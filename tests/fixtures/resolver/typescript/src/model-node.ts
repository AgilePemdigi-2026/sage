export class RecordNode {
  label = "";
  update(value: string): string {
    this.label = value;
    return this.label;
  }
}
