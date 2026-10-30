<?php

namespace Database\Seeders;

use App\Models\Pemicu;
use Illuminate\Database\Seeder;

class PemicuSeeder extends Seeder
{
    public function run(): void
    {
        $pemicus = [
            ['nama' => 'Work', 'ikon' => '💼', 'kategori' => 'Aktivitas'],
            ['nama' => 'Study', 'ikon' => '📚', 'kategori' => 'Aktivitas'],
            ['nama' => 'Exercise', 'ikon' => '💪', 'kategori' => 'Aktivitas'],
            ['nama' => 'Screen Time', 'ikon' => '📱', 'kategori' => 'Aktivitas'],
            ['nama' => 'Sleep', 'ikon' => '😴', 'kategori' => 'Gaya Hidup'],
            ['nama' => 'Food', 'ikon' => '🍔', 'kategori' => 'Gaya Hidup'],
            ['nama' => 'Caffeine', 'ikon' => '☕', 'kategori' => 'Gaya Hidup'],
            ['nama' => 'Weather', 'ikon' => '☁️', 'kategori' => 'Lingkungan'],
            ['nama' => 'Nature', 'ikon' => '🌿', 'kategori' => 'Lingkungan'],
            ['nama' => 'Music', 'ikon' => '🎵', 'kategori' => 'Lingkungan'],
            ['nama' => 'Social', 'ikon' => '👥', 'kategori' => 'Sosial'],
            ['nama' => 'Relationship', 'ikon' => '💕', 'kategori' => 'Sosial'],
            ['nama' => 'Health', 'ikon' => '🏥', 'kategori' => 'Kesehatan'],
            ['nama' => 'Stress', 'ikon' => '😰', 'kategori' => 'Kesehatan'],
            ['nama' => 'Finance', 'ikon' => '💰', 'kategori' => 'Keuangan'],
        ];

        foreach ($pemicus as $pemicu) {
            Pemicu::firstOrCreate(
                ['nama' => $pemicu['nama']],
                $pemicu
            );
        }
    }
}