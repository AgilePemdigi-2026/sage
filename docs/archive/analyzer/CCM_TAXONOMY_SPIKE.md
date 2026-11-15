# Spike taxonomy CCM v1 — ANA-05

Tanggal: 21 Oktober 2026. Issue: [#11](https://github.com/AgilePemdigi-2026/sage/issues/11). Status: hasil karakterisasi teknis untuk review PR; bukan persetujuan formal oracle QA-01.

## Pertanyaan dan keputusan kompatibilitas

Apakah konstruksi TypeAlias, Enum, dan Trait dapat dimasukkan ke tujuh kategori CCM v1 tanpa mengubah maknanya? Tidak. Type alias bukan Interface, enum bukan Class, dan trait bukan Class yang dapat diinstansiasi. Memetakan konstruksi tersebut ke kind yang tersedia akan membuat filter, hitungan, dan proyeksi diagram menyatakan fakta yang keliru.

Untuk implementasi v1 saat ini, pertahankan registry `Module`, `Class`, `Interface`, `Function`, `Method`, `Property`, dan `UnresolvedReference`. Konstruksi di luar registry harus menghasilkan limitation pada file sumber; deklarasi yang didukung dalam file yang sama tetap dianalisis. Referensi yang belum dapat dibuktikan tidak boleh memperoleh target Exact palsu. Ini mencatat batas implementasi saat ini, bukan menghapus konstruksi tersebut dari target pengembangan.

| Konstruksi source | Perlakuan saat ini | Bukti / batas |
| --- | --- | --- |
| JavaScript class/function/member | Kind inti sesuai deklarasi | Tes adapter dan oracle resolver JavaScript |
| TypeScript class/interface/function/member | Kind inti sesuai deklarasi | Tes adapter, Unicode/CRLF, dan oracle resolver TypeScript |
| TypeScript type alias | Limitation `declarations`; tidak disamarkan menjadi Interface | Tes karakterisasi taxonomy |
| TypeScript enum dan member-nya | Limitation `declarations`; tidak disamarkan menjadi Class/Property | Tes karakterisasi taxonomy |
| PHP class/interface/function/method | Kind inti sesuai subset adapter | Tes adapter dan oracle resolver PHP; dukungan property tidak disimpulkan dari registry |
| PHP trait dan member-nya | Limitation `declarations`; tidak disamarkan menjadi Class/Method | Tes karakterisasi taxonomy |
| PHP enum dan member-nya | Limitation `declarations`; tidak disamarkan menjadi Class/Property/Method | Tes karakterisasi taxonomy |
| JSX/TSX | Parser dapat menerima sintaks; tidak ada kind komponen/UI khusus | Dukungan parsing bukan bukti model semantik komponen; di luar keputusan tiga konstruksi ini |

## Pembuktian

`tests/taxonomy-compatibility.test.ts` menjalankan resolver sebenarnya terhadap source literal, memeriksa limitation dan deklarasi sibling, lalu membawa hasil melalui validasi serializable CCM dan canonical CKG. Source PHP diparse, bukan dieksekusi. Pengujian memeriksa identitas dan konten canonical pada urutan input yang dibalik; CKG tidak menambahkan kategori atau fakta dari konstruksi yang dihilangkan.

`tests/contracts.test.ts` juga memalsukan ID edge Exact dan Unresolved. Validator serta canonicalizer wajib menolak keduanya dengan `CCM_EDGE_ID_INVALID`, meskipun endpoint dan evidence tetap valid. Hasil command aktual dicatat pada [ANA-05_CHECKS](ANA-05_CHECKS.md).

## Syarat perluasan registry

Penambahan kind memerlukan keputusan versi/kompatibilitas kontrak, fixture source dengan expected node/member/reference yang diperiksa, label dan filter UI, proyeksi CKG/dokumen, serta pengujian payload lama. Menambah string ke registry saja belum membuktikan dukungan bahasa. Pilihan alternatif adalah model terpisah untuk tipe/trait; alternatif itu juga membutuhkan desain relasi dan migrasi konsumen.

Review formal manifest oracle, benchmark repository representatif, dan batas resource seluruh job tetap merupakan pekerjaan QA-01. Integritas fixture atau tes karakterisasi otomatis tidak menggantikan review formal tersebut. Issue #11 tetap terbuka selama gate acceptance yang tercatat belum dipenuhi.
