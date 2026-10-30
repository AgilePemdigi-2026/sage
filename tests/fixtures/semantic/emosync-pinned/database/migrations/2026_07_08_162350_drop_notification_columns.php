<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::table('user_settings', function (Blueprint $table) {
            $table->dropColumn([
                'notif_daily_reminder',
                'daily_reminder_time',
                'notif_weekly_report',
                'notif_friend_activity',
                'notif_tips_insights'
            ]);
        });

        Schema::table('users', function (Blueprint $table) {
            $table->dropColumn('fcm_device_token');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('user_settings', function (Blueprint $table) {
            $table->boolean('notif_daily_reminder')->default(true);
            $table->string('daily_reminder_time')->default('20:00');
            $table->boolean('notif_weekly_report')->default(true);
            $table->boolean('notif_friend_activity')->default(false);
            $table->boolean('notif_tips_insights')->default(true);
        });

        Schema::table('users', function (Blueprint $table) {
            $table->string('fcm_device_token')->nullable();
        });
    }
};
