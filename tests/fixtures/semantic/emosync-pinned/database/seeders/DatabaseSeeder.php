<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;

class DatabaseSeeder extends Seeder
{
    public function run(): void
    {
        $this->call([
            PemicuSeeder::class,
            ContentSeeder::class,
            AdminSeeder::class,
        ]);
    }
}