<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class Content extends Model
{
    use HasFactory;

    protected $fillable = [
        'title',
        'description',
        'full_content',
        'type',
        'thumbnail_url',
        'video_url',
        'is_premium',
    ];

    protected $casts = [
        'is_premium' => 'boolean',
    ];
}