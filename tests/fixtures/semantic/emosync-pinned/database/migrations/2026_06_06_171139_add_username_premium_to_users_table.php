<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            // Cek apakah kolom username sudah ada
            if (!Schema::hasColumn('users', 'username')) {
                $table->string('username')->unique()->after('name');
            }
            
            // Cek apakah kolom is_premium sudah ada
            if (!Schema::hasColumn('users', 'is_premium')) {
                $table->boolean('is_premium')->default(false)->after('remember_token');
            }
            
            // Cek apakah kolom premium_plan sudah ada
            if (!Schema::hasColumn('users', 'premium_plan')) {
                $table->string('premium_plan')->nullable()->after('is_premium');
            }
            
            // Cek apakah kolom premium_expiry sudah ada
            if (!Schema::hasColumn('users', 'premium_expiry')) {
                $table->timestamp('premium_expiry')->nullable()->after('premium_plan');
            }
        });
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $columns = ['username', 'is_premium', 'premium_plan', 'premium_expiry'];
            
            foreach ($columns as $column) {
                if (Schema::hasColumn('users', $column)) {
                    $table->dropColumn($column);
                }
            }
        });
    }
};