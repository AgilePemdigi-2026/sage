<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class MoodCheckin extends Model
{
    use HasFactory;

    protected $fillable = [
        'user_id',
        'mood',
        'catatan',
    ];

    protected $casts = [
        'created_at' => 'datetime',
    ];

    public function user()
    {
        return $this->belongsTo(User::class);
    }

    public function pemicus()
    {
        return $this->belongsToMany(Pemicu::class, 'checkin_pemicus', 'checkin_id', 'pemicu_id');
    }
}