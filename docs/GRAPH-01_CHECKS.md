# Verifikasi graph tersimpan GRAPH-01

Tanggal: 21 Oktober 2026, Asia/Jakarta. Issue [#17](https://github.com/AgilePemdigi-2026/sage/issues/17). Base `90d05aa40ef126b56f79960a2b9548c668c45d9f`. Pengiriman dan commit: Valentina (`liliks13`). Review dan merge: Iltizam (`iltizamhasan3`) setelah review kode independen.

## Perubahan

Halaman `/analyses/{analysisId}/graph` mengambil graph melalui API terautentikasi dari canonical CKG tersimpan, setelah analisis berstatus `COMPLETED` atau `COMPLETED_WITH_LIMITATIONS`. Pemeriksaan pemilik/status mendahului akses archive. Snapshot source dibaca dari archive aktif terbaru milik analisis yang sama, lalu hash, byte source, mirror, configuration, serta target immutable diverifikasi ulang dengan reader canonical. Archive atau bundle hasil terminal yang hilang/rusak menghasilkan 503 generik; analisis belum sukses menghasilkan 409.

API mengembalikan proyeksi lengkap tanpa source bytes, storage key, atau kredensial. Semua query parameter ditolak sampai kontrak query/filter GRAPH-02 diimplementasikan. Header `Cache-Control: private, no-store`, `Vary: Cookie, X-SAGE-Account`, dan pemeriksaan akun menghindari pemakaian ulang respons lintas akun. SSR hanya mengirim ID analisis dan identitas akun; graph dimuat oleh client dengan pembatalan serta generation guard. Focus/pageshow/visibility memulai pemeriksaan identitas baru dan menghapus graph sebelumnya sebelum fetch; pemeriksaan periodik berlangsung saat halaman terlihat.

Ikhtisar mengelompokkan node di bawah Module canonical; fokus menampilkan node terpilih, tetangga langsung dan edge incident; semua referensi mempertahankan edge selain CONTAINS dan endpoint-nya. Tidak ada node atau relasi hasil tebakan. Legenda membedakan kategori serta Exact/Unresolved, dengan pemilih node keyboard dan kontrol zoom/fit. Jumlah kanonik, hasil mode, dan tampilan memiliki hitungan terpisah untuk node, edge, containment, reference, exact dan unresolved.

Renderer mengirim maksimal 200 node/500 edge secara deterministik ke Cytoscape. Batas ini merupakan budget render antarmuka, bukan klaim kapasitas analisis. Jika dipotong, UI menampilkan batas dan jumlah subset; parent Module hanya dipasang jika tersedia dalam subset yang sama. API tetap mengembalikan proyeksi lengkap.

## Verifikasi aktual

| Pemeriksaan | Expected | Actual |
| --- | --- | --- |
| Lint, typecheck root/web | Tanpa error | PASS |
| Tes utama dan data | Seluruh tes lulus | 261/261 + 8/8 PASS |
| Migration dan build produksi | Schema terbaru, distribusi standalone dapat berjalan | PASS |
| API dengan sesi/PostgreSQL nyata | 200 pemilik; 401 sesi hilang/akun lama; 404 asing/hilang; 409 belum sukses; 400 query | PASS |
| Integrity canonical/archive | 503 aman saat rusak, 200 setelah dipulihkan | PASS |
| Chromium lima viewport | Mode, counts, keyboard, legend, zoom/fit tanpa overflow/error | PASS pada 360/390/768/1024/1440 px |
| Cookie A→B dan respons A terlambat | Canvas/counts A hilang, API B mendapat 404 | PASS |
| Graph kosong dan preview lama | Empty-state valid; preview tanpa API/provider | PASS |
| Retry 503 | Error terlihat lalu retry membaca API nyata | PASS dengan satu respons 503 browser yang diintersep eksplisit |

Laporan browser memuat 16 kelompok pemeriksaan, nol page error dan nol request provider. Fixture TypeScript menghasilkan 14 node/21 edge: 9 containment, 12 reference, 18 Exact, 3 Unresolved. Hash CKG `40ba440a49e3c7344527612dd7c550ca9bf6b006a2d904fa61af4c807bae5891`, snapshot SHA sintetis `dddddddddddddddddddddddddddddddddddddddd`. Node Module, Class, Interface, Function, Method, Property dan UnresolvedReference semuanya berasal dari adapter nyata. Node 24.22.0, Next.js 16.4.2, Prisma 7.10.1, PostgreSQL 17, Chromium 156.0.8078.4.

Pengujian unit mencakup budget subset 205 node/505 edge menjadi 200/500, parent compound yang valid, self-loop/parallel edge, fokus yang incident-only dan hasil kosong. Tes ini tidak mengklaim benchmark graph besar. Satu 503 dan penahanan respons A dikendalikan Playwright untuk menguji recovery/race; API sukses, ownership, integrity, sesi dan database tetap nyata.

```sh
npm run check
npm run db:migrate
npm run build
SAGE_GRAPH_TESTS=1 npm run test:graph:live
git diff --check
```

Tes integrasi wajib memakai database sementara bernama `sage_graph17`, storage sementara privat 0700 yang sama dengan server, serta `CREDENTIAL_ENCRYPTION_KEY` test-only yang sama pada server dan script. Script membuat sesi dan koneksi terenkripsi sintetis; tidak ada token provider nyata atau GitHub OAuth live. Container runner dibatasi 1 CPU/2 GiB; PostgreSQL 0,5 CPU/256 MiB; jaringan internal tanpa port host. Build standalone dijalankan sebagai server sebenarnya untuk memeriksa dependensi archive pada distribusi produksi. Screenshot/laporan tersimpan di `artifacts/graph-17` yang diabaikan Git.

## Batas penerimaan

Fixture berasal dari resolver TypeScript nyata lalu langsung disimpan sebagai canonical GraphBundle dan SOURCE_ARCHIVE pada database uji. Status terminal dibuat oleh setup tes. Ini membuktikan jalur baca hasil tersimpan, API, ownership dan browser; bukan eksekusi/publikasi pipeline sembilan tahap. Submission baru tetap mengikuti aktivasi ANA-07 #16. Query/filter #18, inspector/source #19, dokumen/ekspor serta signoff formal ANA-06 tetap mengikuti issue masing-masing.
