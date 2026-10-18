import { randomBytes } from "node:crypto";
import { appendFile, chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
const generatedValues = () => ({
  POSTGRES_PASSWORD: randomBytes(24).toString("hex"),
  CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
});

function hasVariable(content, name) {
  return new RegExp(`^[\\t ]*${name}[\\t ]*=`, "m").test(content);
}

let content;
let isNewFile = false;
try {
  const info = await lstat(envPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(".env harus berupa file biasa; tidak ada rahasia yang ditulis.");
  content = await readFile(envPath, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  content = "";
  isNewFile = true;
}

const generated = generatedValues();
const additions = [];
if (!hasVariable(content, "POSTGRES_PASSWORD")) additions.push(`POSTGRES_PASSWORD=${generated.POSTGRES_PASSWORD}`);
if (!hasVariable(content, "CREDENTIAL_ENCRYPTION_KEY")) additions.push(`CREDENTIAL_ENCRYPTION_KEY=${generated.CREDENTIAL_ENCRYPTION_KEY}`);
if (isNewFile) additions.push("WEB_PORT=3000");

if (isNewFile) {
  await writeFile(envPath, `${additions.join("\n")}\n`, { flag: "wx", mode: 0o600 });
  console.log(".env lokal dibuat; rahasia tidak ditampilkan.");
} else {
  await chmod(envPath, 0o600);
  if (additions.length > 0) {
    const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    await appendFile(envPath, `${prefix}${additions.join("\n")}\n`, { mode: 0o600 });
    console.log("Konfigurasi .env dilengkapi; nilai yang sudah ada dipertahankan.");
  } else {
    console.log(".env dan kunci kredensial sudah tersedia; konfigurasi dipertahankan.");
  }
}
await chmod(envPath, 0o600);
