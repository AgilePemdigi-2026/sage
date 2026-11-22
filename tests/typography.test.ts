import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const webRoot = join(repositoryRoot, "apps/web");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:css|ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

test("web UI uses the locally bundled Jakarta Sans family", () => {
  const layout = readFileSync(join(webRoot, "app/layout.tsx"), "utf8");
  const globalStyles = readFileSync(join(webRoot, "app/globals.css"), "utf8");
  const webPackage = JSON.parse(readFileSync(join(webRoot, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };

  for (const weight of [400, 500, 600, 700, 800]) {
    assert.ok(layout.includes(`@fontsource/plus-jakarta-sans/${weight}.css`), `weight ${weight} is imported by the root layout`);
  }
  assert.doesNotMatch(layout, /@fontsource\/(?:inter|jetbrains-mono)/i);
  assert.equal(webPackage.dependencies["@fontsource/plus-jakarta-sans"], "5.3.0");
  assert.match(globalStyles, /--font-sans:\s*"Plus Jakarta Sans"/);
  assert.match(globalStyles, /--font-mono:\s*(?:"Plus Jakarta Sans"|var\(--font-sans\))/);
  assert.match(globalStyles, /body\s*\{[^}]*font-family:\s*var\(--font-sans\)/s);

  const familyOverride = /(?:font-family|fontFamily|\bfont)\s*:[^;\n]*/i;
  const otherFamily = /\b(?:Inter|JetBrains\s+Mono|ui-monospace|system-ui|Times\s+New\s+Roman|SFMono-Regular|Menlo|Arial|monospace)\b/i;
  const overrides = [join(webRoot, "app"), join(webRoot, "components")]
    .flatMap(sourceFiles)
    .flatMap((path) => readFileSync(path, "utf8").split(/\r?\n/).map((line, index) => ({
      path: relative(repositoryRoot, path),
      line: index + 1,
      text: line.trim(),
    })))
    .filter(({ text }) => familyOverride.test(text) && !text.includes('fontFamily: "\\"Plus Jakarta Sans\\"') && otherFamily.test(text));

  assert.deepEqual(overrides, [], "no app UI style or canvas renderer should select a different font family");
});
