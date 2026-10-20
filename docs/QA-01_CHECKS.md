# Pemeriksaan oracle resolver QA-01

Bagian ini menambahkan oracle independen yang ditulis dari source fixture kecil JavaScript, TypeScript, dan PHP. Fakta relasi dan referensi yang belum dapat diselesaikan tidak diambil dari keluaran analyzer. Manifest masih berstatus `DRAFT_AWAITING_TEAM_REVIEW`; hasil ini belum menyatakan penerimaan semantik.

## Cakupan fixture

Fixture mencakup impor dan pemanggilan lintas file, referensi tipe dan pewarisan TypeScript, namespace, impor dan pewarisan PHP, dynamic import JavaScript, receiver yang tidak diketahui, parameter yang menimpa nama impor, simbol JavaScript dan PHP yang tidak tersedia, Unicode, CRLF, serta canary `throw` di tingkat atas. Source canary hanya untuk analisis statis dan tidak boleh dieksekusi.

`tests/fixtures/resolver/resolver-oracle-v1.json` mencatat path setiap fixture, SHA-256, ukuran byte, jenis relasi, nama qualified source dan target yang diharapkan atau nama serta alasan untuk target yang belum terselesaikan, juga bukti literal beserta offset byte UTF-8 dan posisi baris/kolom. Verifier hanya memeriksa integritas data dan cakupan skenario; verifier tidak memanggil resolver.

Untuk `use Resolver\Contracts\Base;` dan `use Resolver\Contracts\Missing;`, bukti impor mencakup seluruh nama qualified. Span `Base` saja juga menunjuk simbol yang diimpor, tetapi nama lengkap lebih tepat untuk merekam referensi namespace yang benar-benar ditulis dan membedakannya dari simbol bernama sama di namespace lain. Span relasi `extends Base` tetap hanya mencakup `Base`, karena itulah token yang dirujuk pada deklarasi pewarisan.

## Perintah dan hasil saat ini

Jalankan pemeriksaan dari root repository:

```sh
node --import tsx --test tests/resolver-oracles.test.ts
npm run fixtures:verify:resolvers
npm run benchmark:resolvers
```

Lima tes integritas terarah lulus pada Docker Node 24.22.0. Selain itu, `npm run check` pada branch QA lulus di image `sage-worker:local` dengan Node 24.22.0 dan PHP 8.4.26, jaringan nonaktif, batas 1 CPU dan memori 2 GiB: lint, typecheck root dan web, 181 tes aplikasi, serta 8 tes data. Pemeriksaan integritas mencakup manifest, hash dan canary file, perubahan literal/span, batas UTF-8, posisi CRLF, path tidak aman, file duplikat, alasan unresolved yang tidak valid, cakupan minimum tiap bahasa, serta symlink yang keluar dari root.

Benchmark tidak menetapkan penerimaan semantik. Oracle masih berstatus draft sampai ditinjau tim. Benchmark memproses JavaScript dan TypeScript dengan adapter JS, serta hanya PHP dengan adapter PHP. Untuk tiap adapter, benchmark mencatat tiga iterasi, jumlah file dan byte input, waktu, RSS proses Node pemanggil, status/error code adapter, jumlah node/edge CCM, dan hash konten jika tersedia. Status `complete` maupun `partial` diterima jika `errorCode` bernilai `null` dan CCM berisi array node serta edge; status gagal, error code non-null, atau CCM tidak valid membuat benchmark gagal dan tidak diberi status `COMPLETE`.

Jika API resolver belum tersedia, benchmark mencetak `NOT_RUN` dan keluar dengan kode nonzero. Benchmark tidak menggunakan adapter deklarasi saja ataupun mock. Hasil waktunya tetap belum menjadi bukti penerimaan semantik.

Enam source fixture ini hanya cocok untuk microbenchmark terarah, bukan sampel performa repository nyata. RSS yang dilaporkan hanya milik proses Node pemanggil; RSS proses anak PHP dan puncak memori worker tidak diukur. Jumlah node/edge dan hash konten bersifat deskriptif, bukan bukti kebenaran semantik. Peninjauan tim terhadap oracle masih menunggu.
