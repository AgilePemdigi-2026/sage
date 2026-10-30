<?php

namespace Database\Seeders;

use App\Models\User;
use App\Models\Pemicu;
use Illuminate\Database\Seeder;

class DummyDataSeeder extends Seeder
{
    public function run(): void
    {
        // User dummy
        User::firstOrCreate(
            ['username' => 'demasaxel'],
            [
                'name' => 'Demas Axel',
                'email' => 'demas@example.com',
                'password' => bcrypt('password123'),
            ]
        );

        // Pemicu dummy
        $pemicus = [
            ['nama' => 'Kurang Tidur', 'ikon' => '😴', 'kategori' => 'Aktivitas'],
            ['nama' => 'Konflik Sosial', 'ikon' => '😤', 'kategori' => 'Sosial'],
            ['nama' => 'Lingkungan Bising', 'ikon' => '🔊', 'kategori' => 'Lingkungan'],
            ['nama' => 'Banyak Tugas', 'ikon' => '📚', 'kategori' => 'Aktivitas'],
            ['nama' => 'Olahraga', 'ikon' => '🏃', 'kategori' => 'Aktivitas'],
            ['nama' => 'Kurang Makan', 'ikon' => '🍽️', 'kategori' => 'Aktivitas'],
            ['nama' => 'Hujan', 'ikon' => '🌧️', 'kategori' => 'Lingkungan'],
            ['nama' => 'Support Teman', 'ikon' => '💪', 'kategori' => 'Sosial'],
        ];

        foreach ($pemicus as $pemicu) {
            Pemicu::firstOrCreate(
                ['nama' => $pemicu['nama']],
                $pemicu
            );
        }
    }
}
