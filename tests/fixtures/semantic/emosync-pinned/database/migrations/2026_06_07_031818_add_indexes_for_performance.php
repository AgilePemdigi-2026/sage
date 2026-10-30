<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Index untuk mood_checkins
        Schema::table('mood_checkins', function (Blueprint $table) {
            $table->index(['user_id', 'created_at']);
            $table->index('mood');
        });
        
        // Index untuk friendships
        Schema::table('friendships', function (Blueprint $table) {
            $table->index(['user_id', 'friend_id', 'status']);
            $table->index('status');
        });
        
        // Index untuk users
        Schema::table('users', function (Blueprint $table) {
            $table->index('username');
            $table->index('email');
        });
        
        // Index untuk personal_access_tokens
        Schema::table('personal_access_tokens', function (Blueprint $table) {
            $table->index('tokenable_id');
        });
    }

    public function down(): void
    {
        Schema::table('mood_checkins', function (Blueprint $table) {
            $table->dropIndex(['user_id', 'created_at']);
            $table->dropIndex(['mood']);
        });
        
        Schema::table('friendships', function (Blueprint $table) {
            $table->dropIndex(['user_id', 'friend_id', 'status']);
            $table->dropIndex(['status']);
        });
        
        Schema::table('users', function (Blueprint $table) {
            $table->dropIndex(['username']);
            $table->dropIndex(['email']);
        });
        
        Schema::table('personal_access_tokens', function (Blueprint $table) {
            $table->dropIndex(['tokenable_id']);
        });
    }
};