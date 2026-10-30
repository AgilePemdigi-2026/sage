<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class UserSetting extends Model
{
    use HasFactory;

    protected $table = 'user_settings';

    protected $fillable = [
        'user_id',

        'privacy_show_mood',
        'privacy_allow_requests',
        'privacy_show_active',
        'privacy_show_last_seen',
    ];

    protected $casts = [

        'privacy_show_mood' => 'boolean',
        'privacy_allow_requests' => 'boolean',
        'privacy_show_active' => 'boolean',
        'privacy_show_last_seen' => 'boolean',
    ];

    /**
     * Get the user that owns the settings.
     */
    public function user()
    {
        return $this->belongsTo(User::class);
    }
}