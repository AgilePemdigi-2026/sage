<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class Friendship extends Model
{
    use HasFactory;

    protected $fillable = [
        'user_id',
        'friend_id',
        'status',
    ];

    protected $casts = [
        'created_at' => 'datetime',
        'updated_at' => 'datetime',
    ];

    // ============ RELATIONSHIPS ============
    
    // User yang mengirim permintaan
    public function user()
    {
        return $this->belongsTo(User::class, 'user_id');
    }

    // User yang menerima permintaan
    public function friend()
    {
        return $this->belongsTo(User::class, 'friend_id');
    }
}