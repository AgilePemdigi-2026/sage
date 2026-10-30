<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class Pemicu extends Model
{
    use HasFactory;

    protected $fillable = ['nama', 'ikon', 'kategori'];

    public function moodCheckins()
    {
        return $this->belongsToMany(MoodCheckin::class, 'checkin_pemicus');
    }
}