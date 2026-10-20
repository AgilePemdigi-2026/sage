# `@sage/contracts`

Tipe schema v1, registry, ID deterministik, serialisasi canonical, dan validasi runtime untuk Common Code Model (CCM) minimum. Paket ini memeriksa struktur payload dan integritas evidence terhadap source; paket ini tidak mem-parse PHP/JavaScript/TypeScript atau membuktikan bahwa adapter telah menemukan semua fakta semantik.

## Validasi snapshot

Kirim CCM serializable dan peta byte persis dari snapshot secara terpisah. Ukuran dan SHA-256 file dicocokkan dengan byte tersebut, lalu setiap rentang source/evidence diperiksa terhadap input immutable yang sama. Payload tidak menyimpan isi source.

```ts
import { readFile } from "node:fs/promises";
import { validateCcm } from "@sage/contracts";

const payload: unknown = JSON.parse(await readFile("minimum-ccm.json", "utf8"));
const sourceBytes = {
  "examples/minimum-ccm.source.ts": await readFile("examples/minimum-ccm.source.ts"),
};
const result = validateCcm(payload, sourceBytes);
if (!result.ok) throw new Error(result.errorCode);
```

Lihat [`examples/minimum-ccm.json`](examples/minimum-ccm.json) dan file source pendampingnya. Kegagalan validasi mengembalikan nilai `errorCode` yang stabil tanpa membuka isi source.

## Canonicalization

`canonicalizeCcm` memvalidasi payload dan byte source, lalu mengembalikan JSON canonical beserta SHA-256-nya. File diurutkan menurut path, node dan edge menurut ID deterministik, limitation menurut JSON canonical, evidence edge menurut path/batas byte/role, dan key pada object attributes diurutkan secara rekursif. ID node mencakup full SHA snapshot, bahasa, path, kind, qualified name, dan batas byte deklarasi. ID edge mencakup full SHA snapshot, endpoint, kind, resolution, alasan unresolved, dan evidence. Job ID, timestamp, progres antrean, serta data envelope lainnya berada di luar payload CCM canonical.

Evidence memakai offset byte UTF-8 berbasis nol dengan batas akhir eksklusif. Nomor baris berbasis satu dan inklusif untuk rentang; kolom berbasis satu dalam Unicode code point dengan batas akhir eksklusif. Validator mengikuti konvensi fixture yang direview untuk CRLF (`\r` dihitung pada prefix sebelum `\n`) dan memakai `ignoreBOM: true`, sehingga byte BOM tetap dihitung pada offset. Node source wajib memiliki rentang deklarasi. Node `stdlib`, `external`, dan `unresolved` memiliki lokasi deklarasi null; placeholder unresolved harus menjadi target edge `Unresolved` dengan evidence reference pada file snapshot.

## Integritas input dan containment

Koleksi payload harus berupa array biasa yang padat, dengan elemen data enumerable dan tanpa properti tambahan. Peta source hanya menerima properti data milik object itu sendiri; getter ditolak tanpa dipanggil. Ini adalah kontrak data serializable, bukan sandbox untuk object JavaScript atau Proxy yang tidak dipercaya.

Seluruh byte file berstatus `processed` harus valid UTF-8, termasuk bagian di luar evidence. File `failed` atau `excluded` boleh menyimpan byte non-UTF-8 agar laporan snapshot tetap lengkap; hash dan ukuran aslinya tetap diperiksa.

Rentang deklarasi anak harus berada di dalam rentang parent pada file yang sama. Pemeriksaan siklus parent memakai traversal iteratif. Edge `CONTAINS` yang diberikan harus `Exact`, menghubungkan parent source ke anak source sesuai `parentId`, dan menyertakan evidence deklarasi anak. Validator tidak mewajibkan edge containment pada output adapter deklarasi yang belum menjalankan resolver. Pelanggaran rentang parent memakai `CCM_NODE_PARENT_BOUNDS_INVALID`; edge containment yang tidak konsisten memakai `CCM_EDGE_CONTAINMENT_INVALID`.

Registry schema v1 tetap memakai tujuh kategori inti. `TypeAlias`, `Enum`, dan `Trait` belum ditambahkan; adapter mencatat keterbatasannya sesuai [spesifikasi analisis](../../docs/ANALYSIS_SPEC.md). Hasil JSON yang telah disimpan harus divalidasi kembali bersama byte snapshot sebelum dikonsumsi. Bukti hardening dan kompatibilitas adapter tersedia pada [ANA-05](../../docs/ANA-05_CHECKS.md).

## Cakupan

Ini adalah fondasi kontrak minimum v1. ANA-05 lengkap masih memerlukan perilaku adapter/resolver, pemeriksaan kelengkapan dan capability terhadap oracle PHP/JS/TS yang direview, penerapan batas resource, integrasi persistensi/API, serta replay end-to-end. CCM valid hanya membuktikan bahwa payload cocok dengan struktur terdaftar dan byte source yang diberikan.
