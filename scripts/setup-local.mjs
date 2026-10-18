import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

try {
  await writeFile(new URL("../.env", import.meta.url), `POSTGRES_PASSWORD=${randomBytes(24).toString("hex")}\nWEB_PORT=3000\n`, { flag: "wx", mode: 0o600 });
  console.log(".env lokal dibuat; password tidak ditampilkan.");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log(".env sudah tersedia; konfigurasi lama dipertahankan.");
}
