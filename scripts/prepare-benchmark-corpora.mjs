import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));

// Only these public, pinned repositories may be fetched; manifest paths never become shell text.
for (const id of ["sage-js", "php-parser"]) {
  const manifest = JSON.parse(await readFile(resolve(project, `docs/evidence/corpora/${id}.json`), "utf8"));
  const repository = id === "sage-js" ? "AgilePemdigi-2026/sage" : "nikic/PHP-Parser";
  if (manifest.repository !== repository || !/^[a-f0-9]{40}$/.test(manifest.commitSha)) throw new Error("CORPUS_IDENTITY_INVALID");
  const checkout = resolve(project, `storage/benchmarks/git/${id}`);
  await mkdir(checkout, { recursive: true });
  // No checkout, hooks, dependency installation or source/config execution.
  await exec("git", ["-C", checkout, "init", "--bare"], { timeout: 30_000 });
  await exec("git", ["-C", checkout, "-c", "core.hooksPath=/dev/null", "fetch", "--depth=1", "--no-tags",
    `https://github.com/${repository}.git`, manifest.commitSha], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  const destination = resolve(project, `storage/benchmarks/qa01/${id}`);
  for (const file of manifest.files) {
    if (typeof file.path !== "string" || !Array.from(file.path).every(char => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./-[]()".includes(char)) ||
        file.path.split("/").some(part => !part || part === "." || part === "..") || file.path.startsWith("/")) throw new Error("CORPUS_PATH_INVALID");
    const { stdout } = await exec("git", ["-C", checkout, "show", `${manifest.commitSha}:${file.path}`],
      { timeout: 30_000, encoding: "buffer", maxBuffer: 1_048_577 });
    if (stdout.length !== file.sizeBytes || createHash("sha256").update(stdout).digest("hex") !== file.sha256) throw new Error("CORPUS_HASH_MISMATCH");
    const target = resolve(destination, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, stdout);
  }
  console.log(`${id}: ${manifest.files.length} pinned files verified`);
}
