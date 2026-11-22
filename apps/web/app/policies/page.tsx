import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Kebijakan layanan" };
export const dynamic = "force-dynamic";

export default function PoliciesPage() {
  const contact = process.env.SAGE_PRIVACY_CONTACT_EMAIL?.trim();
  const email = contact && /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/iu.test(contact) ? contact : null;
  return <main id="main-content" className="sage-policies">
    <Link href="/">Kembali ke beranda</Link>
    <h1>Kebijakan layanan SAGE</h1>
    <p>SAGE adalah proyek dokumentasi arsitektur perangkat lunak dari AgilePemdigi 2026. <a href="https://github.com/AgilePemdigi-2026/sage">Repositori proyek</a></p>
    <nav aria-label="Daftar kebijakan"><ul>
      <li><a href="#privasi">Privasi</a></li>
      <li><a href="#ketentuan">Ketentuan layanan</a></li>
      <li><a href="#pengembalian-dana">Pengembalian dana</a></li>
      <li><a href="#cookie">Cookie</a></li>
      <li><a href="#penghapusan">Penghapusan data</a></li>
    </ul></nav>

    <section aria-labelledby="privasi">
      <h2 id="privasi">Kebijakan privasi</h2>
      <p>SAGE menggunakan identitas dan username GitHub, nama profil jika tersedia, serta kredensial GitHub yang terenkripsi untuk mengelola sesi dan akses repositori. Saat kamu memulai analisis, SAGE memproses snapshot commit dan menyimpan hasil analisis, riwayat, serta artefak ekspor yang dihasilkan.</p>
      <p>GitHub menangani proses login dan menyediakan akses repositori. Jika kamu memilih bantuan LLM, penyedia LLM kampus menerima ringkasan fakta arsitektur untuk menyusun narasi. Pilihan ini tidak wajib untuk membuat dokumen.</p>
      <p>Layanan ditujukan untuk pengguna dewasa. Jangan sertakan data pribadi anak di repositori yang dikirim untuk dianalisis. Hubungi pengelola jika kamu menduga data anak sudah terunggah.</p>
    </section>

    <section aria-labelledby="ketentuan">
      <h2 id="ketentuan">Ketentuan layanan</h2>
      <p>Analisis hanya repositori yang boleh kamu akses dan proses. Periksa hasil dan bukti sumber sebelum menggunakannya untuk mengambil keputusan. Analisis statis dapat melewatkan perilaku runtime atau pola kode yang tidak didukung.</p>
    </section>

    <section aria-labelledby="pengembalian-dana">
      <h2 id="pengembalian-dana">Pengembalian dana</h2>
      <p>SAGE tidak memungut biaya dan tidak memproses pembayaran atau langganan. Tidak ada transaksi SAGE yang perlu dikembalikan dananya.</p>
    </section>

    <section aria-labelledby="cookie">
      <h2 id="cookie">Kebijakan cookie</h2>
      <p>SAGE menggunakan cookie sesi untuk menjaga login dan cookie sementara untuk menyelesaikan login GitHub. Keduanya diperlukan untuk autentikasi. SAGE tidak menggunakan cookie iklan atau analitik.</p>
    </section>

    <section aria-labelledby="penghapusan">
      <h2 id="penghapusan">Permintaan penghapusan data</h2>
      <p>Analisis individual dapat dihapus dari <Link href="/workspace/history">Riwayat</Link>. Untuk meminta penghapusan akun atau data lainnya, hubungi pengelola secara privat. Sertakan username GitHub dan data yang ingin dihapus. Jangan kirim password, token, atau isi repositori.</p>
      {email ? <p><a href={`mailto:${encodeURIComponent(email).replace("%40", "@")}?subject=Permintaan%20penghapusan%20data%20SAGE`}>Kirim permintaan penghapusan data</a></p> : <p><a href="https://github.com/orgs/AgilePemdigi-2026/people">Temukan pengelola AgilePemdigi</a> dan minta kanal kontak privat. Hindari mengirim detail akun melalui issue publik.</p>}
    </section>
  </main>;
}
