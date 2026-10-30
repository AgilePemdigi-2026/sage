<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('user_settings', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->onDelete('cascade');
            
            // Notification settings
            $table->boolean('notif_daily_reminder')->default(true);
            $table->boolean('notif_weekly_report')->default(true);
            $table->boolean('notif_friend_activity')->default(false);
            $table->boolean('notif_tips_insights')->default(true);
            
            // Privacy settings
            $table->boolean('privacy_show_mood')->default(true);
            $table->boolean('privacy_allow_requests')->default(true);
            $table->boolean('privacy_show_active')->default(true);
            
            $table->timestamps();
            
            // Unique constraint
            $table->unique('user_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('user_settings');
    }
};