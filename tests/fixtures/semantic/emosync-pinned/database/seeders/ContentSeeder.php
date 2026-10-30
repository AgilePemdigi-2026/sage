<?php

namespace Database\Seeders;

use App\Models\Content;
use Illuminate\Database\Seeder;

class ContentSeeder extends Seeder
{
    public function run(): void
    {
        $contents = [
            [
                'title' => 'Kekuatan dari Kebiasaan Kecil',
                'description' => 'Bagaimana mencatat hal kecil setiap hari dapat mengubah kesehatan mentalmu.',
                'full_content' => 'Pernahkah Anda merasa kewalahan dengan target besar yang ingin dicapai? Kabar baiknya, perubahan besar selalu dimulai dari langkah-langkah kecil. Dalam psikologi, ini disebut sebagai "atomic habits" — kebiasaan-kebiasaan kecil yang apabila dilakukan secara konsisten, akan membawa dampak luar biasa dalam jangka panjang.

Mulailah dengan hal yang paling sederhana: tulis satu hal yang Anda syukuri setiap pagi. Luangkan waktu dua menit untuk menarik napas dalam-dalam sebelum memulai aktivitas. Atau berjalan kaki selama lima menit di sekitar rumah setelah makan siang.

Kuncinya adalah konsistensi, bukan intensitas. Sebuah kebiasaan kecil yang dilakukan setiap hari jauh lebih berharga daripada usaha besar yang hanya dilakukan sekali. Otak kita perlahan akan beradaptasi dan menjadikan aktivitas positif ini sebagai bagian alami dari rutinitas harian.

Mulailah hari ini. Satu langkah kecil. Satu perubahan sederhana. Kesehatan mental yang lebih baik bukanlah tujuan yang mustahil — ia dibangun dari kebiasaan-kebiasaan kecil yang kita pilih untuk dilakukan setiap hari.',
                'type' => 'ARTIKEL',
                'is_premium' => false,
            ],
            [
                'title' => 'Rutinitas Malam untuk Tidur Berkualitas',
                'description' => 'Coba teknik peregangan otot ringan sebelum tidur untuk kualitas istirahat lebih baik.',
                'full_content' => 'Tidur yang berkualitas adalah fondasi kesehatan mental yang baik. Sayangnya, banyak dari kita mengabaikan pentingnya rutinitas malam yang menenangkan. Berikut adalah panduan langkah demi langkah yang bisa Anda terapkan mulai malam ini:

1. Matikan layar gadget 30-60 menit sebelum tidur. Cahaya biru dari layar menghambat produksi melatonin, hormon yang mengatur siklus tidur Anda.

2. Lakukan peregangan ringan selama 5-10 menit. Fokus pada area leher, bahu, dan punggung yang tegang setelah seharian beraktivitas.

3. Turunkan suhu ruangan. Suhu tubuh yang lebih rendah membantu otak memasuki mode istirahat. Atur suhu ruangan sekitar 18-22°C untuk kenyamanan optimal.

4. Minum teh herbal tanpa kafein seperti chamomile atau peppermint. Hindari minuman berkafein setidaknya 6 jam sebelum tidur.

5. Baca buku fisik (bukan dari layar) selama 15-20 menit. Aktivitas ini membantu mengalihkan pikiran dari stres harian.

6. Tulis jurnal singkat tentang apa yang terjadi hari ini dan apa yang Anda rencanakan besok. Melepaskan beban pikiran ke dalam tulisan membantu otak untuk "mematikan" mode waspada.

Konsistensi adalah kunci. Tubuh Anda akan belajar mengenali pola ini sebagai sinyal bahwa sudah waktunya untuk beristirahat.',
                'type' => 'ARTIKEL',
                'is_premium' => false,
            ],
            [
                'title' => '5 Menit Teknik Pernapasan',
                'description' => 'Video panduan pernapasan dalam untuk menenangkan pikiran dan tubuh.',
                'full_content' => 'Teknik pernapasan 4-7-8 adalah metode sederhana namun ampuh untuk menenangkan sistem saraf Anda. Dalam video ini, Anda akan dipandu melalui latihan pernapasan yang dapat dilakukan di mana saja, kapan saja. Cocok untuk mengurangi kecemasan, meningkatkan fokus, dan mempersiapkan tubuh untuk tidur.',
                'type' => 'VIDEO',
                'video_url' => 'https://www.youtube.com/watch?v=9fEo9my03Ks',
                'is_premium' => false,
            ],
            [
                'title' => 'Langkah Kecil Berarti Besar',
                'description' => '"Perjalanan seribu mil dimulai dengan satu langkah kecil." - Lao Tzu',
                'full_content' => 'Perjalanan seribu mil dimulai dengan satu langkah kecil. Begitu pula dengan kesehatan mental. Setiap usaha kecil yang Anda lakukan hari ini adalah investasi untuk masa depan yang lebih tenang dan bahagia. Jangan remehkan kekuatan dari satu napas dalam, satu senyuman, atau satu kata maaf. Karena dari hal-hal kecil itulah kebahagiaan sejati dibangun.',
                'type' => 'KUTIPAN',
                'is_premium' => false,
            ],
            [
                'title' => 'Memahami Hormon Kebahagiaan',
                'description' => 'Mengenal Dopamin, Serotonin, Endorfin, dan Oksitosin.',
                'full_content' => 'Pernah bertanya-tanya mengapa olahraga membuat kita merasa bahagia? Atau mengapa pelukan terasa menenangkan? Jawabannya ada pada empat hormon kebahagiaan yang diproduksi secara alami oleh tubuh kita. Video ini akan menjelaskan secara sederhana cara kerja Dopamin, Serotonin, Endorfin, dan Oksitosin — serta bagaimana Anda dapat merangsang produksinya secara alami melalui aktivitas sehari-hari.',
                'type' => 'VIDEO',
                'video_url' => 'https://www.youtube.com/watch?v=CAgj-mLJZzw',
                'is_premium' => true,
            ],
            [
                'title' => 'Self-Compassion',
                'description' => 'Belajar untuk lebih baik kepada diri sendiri adalah kunci kesehatan mental.',
                'full_content' => 'Self-compassion atau welas asih terhadap diri sendiri adalah kemampuan untuk memperlakukan diri sendiri dengan kebaikan, pengertian, dan penerimaan — terutama saat mengalami kegagalan atau kesulitan. Banyak dari kita terbiasa menjadi kritikus terkeras bagi diri sendiri, tanpa menyadari dampak negatifnya terhadap kesehatan mental.

Dr. Kristin Neff, peneliti pionir di bidang self-compassion, mengidentifikasi tiga komponen utama:

1. Self-Kindness (Kebaikan pada Diri Sendiri): Bersikap hangat dan pengertian terhadap diri sendiri saat menderita, gagal, atau merasa tidak cukup baik, alih-alih mengkritik dengan keras.

2. Common Humanity (Kemanusiaan yang Sama): Mengakui bahwa penderitaan dan ketidaksempurnaan adalah bagian dari pengalaman manusia yang universal. Anda tidak sendirian.

3. Mindfulness (Kesadaran Penuh): Menyeimbangkan emosi negatif dengan perspektif yang lebih luas, tanpa berlebihan atau mengabaikan perasaan.

Praktik self-compassion telah terbukti secara ilmiah dapat mengurangi kecemasan, depresi, dan stres, serta meningkatkan ketahanan emosional, kepuasan hidup, dan hubungan interpersonal.

Mulailah dengan latihan sederhana: saat Anda menyadari sedang mengkritik diri sendiri, berhenti sejenak, tarik napas, dan tanyakan "Apa yang akan saya katakan kepada sahabat saya jika ia berada dalam situasi ini?" Kemudian, berikan kata-kata itu kepada diri Anda sendiri.',
                'type' => 'ARTIKEL',
                'is_premium' => true,
            ],
            [
                'title' => 'Meditasi 10 Menit',
                'description' => 'Panduan meditasi singkat untuk memulai hari dengan tenang.',
                'full_content' => 'Meditasi adalah salah satu alat paling ampuh untuk menjaga kesehatan mental. Dalam video meditasi terpandu selama 10 menit ini, Anda akan diajak untuk fokus pada napas, melepaskan ketegangan, dan memulai hari dengan ketenangan. Cocok untuk pemula maupun yang sudah berpengalaman.',
                'type' => 'VIDEO',
                'video_url' => 'https://www.youtube.com/watch?v=H_uc-uQ3Nkc',
                'is_premium' => true,
            ],
            [
                'title' => 'Ketenangan Bukan Berarti Hening',
                'description' => '"Ketenangan bukan berarti tidak ada badai, melainkan tetap tenang di tengah badai."',
                'full_content' => 'Ketenangan bukan berarti tidak ada badai, melainkan tetap tenang di tengah badai. Kesehatan mental bukan tentang menghindari masalah, melainkan tentang bagaimana kita menghadapinya. Izinkan diri Anda untuk merasa, untuk jatuh, dan untuk bangkit kembali. Karena di dalam setiap badai, ada pelajaran berharga yang menanti untuk ditemukan.',
                'type' => 'KUTIPAN',
                'is_premium' => true,
            ],
            [
                'title' => 'Mindfulness untuk Pemula',
                'description' => 'Panduan lengkap mindfulness untuk memulai perjalanan kesehatan mental.',
                'full_content' => 'Mindfulness adalah praktik memberikan perhatian penuh pada momen saat ini tanpa menghakimi. Berasal dari tradisi meditasi Buddhis, mindfulness kini telah diadopsi secara luas dalam psikologi modern sebagai alat yang efektif untuk mengelola stres, kecemasan, dan depresi.

Berikut panduan langkah demi langkah untuk memulai praktik mindfulness:

1. Mulai dari 3-5 Menit Sehari
Anda tidak perlu bermeditasi selama satu jam. Mulailah dengan 3-5 menit setiap hari. Duduklah dengan nyaman, tutup mata, dan fokus pada napas Anda. Saat pikiran mengembara (dan pasti akan mengembara), kembalikan perhatian Anda ke napas dengan lembut.

2. Praktikkan Mindfulness dalam Aktivitas Sehari-hari
Mindfulness tidak terbatas pada meditasi formal. Coba praktikkan saat makan — perhatikan rasa, tekstur, dan aroma makanan. Saat berjalan — rasakan kaki menyentuh tanah. Saat mencuci piring — rasakan air hangat di tangan Anda.

3. Gunakan Teknik STOP
S - Stop (Berhenti sejenak)
T - Take a breath (Ambil napas dalam)
O - Observe (Amati apa yang Anda rasakan saat ini)
P - Proceed (Lanjutkan dengan kesadaran penuh)

4. Jangan Hakimi Diri Sendiri
Pikiran yang mengembara bukanlah kegagalan. Justru, menyadari bahwa pikiran mengembara dan membawanya kembali adalah latihan mindfulness itu sendiri.

5. Gunakan Aplikasi atau Panduan
Banyak aplikasi seperti Headspace, Calm, atau Meditasi.id yang menyediakan panduan mindfulness untuk pemula. Gunakan sebagai teman belajar.

Manfaat mindfulness yang telah terbukti secara ilmiah: mengurangi stres, meningkatkan konsentrasi, mengelola emosi, meningkatkan kualitas tidur, dan menurunkan tekanan darah.',
                'type' => 'ARTIKEL',
                'is_premium' => true,
            ],
            [
                'title' => 'Yoga untuk Ketenangan',
                'description' => 'Gerakan yoga sederhana untuk mengurangi stres.',
                'full_content' => 'Yoga adalah praktik kuno yang menggabungkan gerakan fisik, pernapasan, dan meditasi untuk menciptakan keseimbangan antara tubuh dan pikiran. Video ini memandu Anda melalui gerakan yoga sederhana yang dirancang khusus untuk mengurangi ketegangan dan meningkatkan relaksasi. Cocok untuk semua tingkat kemampuan, termasuk pemula yang baru pertama kali mencoba yoga.',
                'type' => 'VIDEO',
                'video_url' => 'https://www.youtube.com/watch?v=yqeirBfn2j4',
                'is_premium' => true,
            ],
        ];

        foreach ($contents as $content) {
            Content::create($content);
        }
    }
}