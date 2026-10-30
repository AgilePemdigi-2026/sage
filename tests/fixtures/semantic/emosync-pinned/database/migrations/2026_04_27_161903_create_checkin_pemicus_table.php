<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('checkin_pemicus', function (Blueprint $table) {
            $table->id();
            $table->foreignId('checkin_id')->constrained('mood_checkins')->onDelete('cascade');
            $table->foreignId('pemicu_id')->constrained()->onDelete('cascade');
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('checkin_pemicus');
    }
};