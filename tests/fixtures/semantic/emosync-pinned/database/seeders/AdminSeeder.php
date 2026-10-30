<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;

class AdminSeeder extends Seeder
{
    public function run(): void
    {
        User::firstOrCreate(
            ['email' => 'admin@emosync.com'],
            [
                'name' => 'Admin EmoSync',
                'username' => 'admin',
                'email' => 'admin@emosync.com',
                'password' => Hash::make('admin123'),
                'is_admin' => true,
                'is_premium' => false,
            ]
        );

        $this->command->info('Admin user created: admin@emosync.com / admin123');
    }
}
