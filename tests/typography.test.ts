import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

test("web UI self-hosts Jakarta Sans and JetBrains Mono through next/font/local and the font tokens", () => {
  const layout = readFileSync(join(webRoot, "app/layout.tsx"), "utf8");
  const globalStyles = readFileSync(join(webRoot, "app/globals.css"), "utf8");
  const webPackage = JSON.parse(readFileSync(join(webRoot, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };

  // Subset latin woff2 lokal, hanya weight yang dipakai; tanpa CSS @fontsource yang render-blocking.
  assert.match(layout, /from "next\/font\/local"/);
  for (const weight of [400, 500, 600, 700, 800]) {
    assert.ok(layout.includes(`./fonts/plus-jakarta-sans-latin-${weight}-normal.woff2`), `Jakarta weight ${weight} is self-hosted`);
    assert.ok(existsSync(join(webRoot, `app/fonts/plus-jakarta-sans-latin-${weight}-normal.woff2`)));
  }
  for (const weight of [400, 500, 600, 700]) {
    assert.ok(layout.includes(`./fonts/jetbrains-mono-latin-${weight}-normal.woff2`), `mono weight ${weight} is self-hosted`);
    assert.ok(existsSync(join(webRoot, `app/fonts/jetbrains-mono-latin-${weight}-normal.woff2`)));
  }
  assert.equal((layout.match(/display: "swap"/g) ?? []).length, 2, "every font face uses font-display: swap");
  assert.equal((layout.match(/preload: true/g) ?? []).length, 1, "only the UI/headline family (Jakarta) is preloaded; mono is not");
  assert.doesNotMatch(layout, /@fontsource\//i);
  assert.equal(Object.keys(webPackage.dependencies).filter(name => name.startsWith("@fontsource/")).length, 0);
  assert.match(globalStyles, /--font-sans:\s*var\(--font-jakarta\)/);
  // Kode, path, SHA, dan nomor baris memakai JetBrains Mono, hanya lewat token --font-mono.
  assert.match(globalStyles, /--font-mono:\s*var\(--font-jetbrains-mono\)/);
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
