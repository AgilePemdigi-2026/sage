import { normalize, exercise } from "./format.js";
import { unavailable } from "./missing-module.js";

export function render(value) {
  return normalize(value);
}

export function invoke(target) {
  return exercise(target);
}

export async function load(name) {
  return import(name);
}

export function shadowed(normalize) {
  return normalize("shadowed");
}

export function useUnavailable() {
  return unavailable();
}
