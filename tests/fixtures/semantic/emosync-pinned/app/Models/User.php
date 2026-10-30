<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Laravel\Sanctum\HasApiTokens;
use Illuminate\Support\Facades\DB;

class User extends Authenticatable
{
    use HasApiTokens, HasFactory, Notifiable;

    protected $fillable = [
        'name',
        'username',
        'email',
        'password',
        'is_premium',
        'premium_plan',
        'premium_expiry',
        'avatar',

    ];

    protected $hidden = [
        'password',
        'remember_token',
    ];

    protected $casts = [
        'email_verified_at' => 'datetime',
        'password' => 'hashed',
        'premium_expiry' => 'datetime',
        'is_premium' => 'boolean',
    ];

    // ============ CHAT RELATIONSHIPS ============

    public function sentMessages()
    {
    return $this->hasMany(Chat::class, 'sender_id');
    }

    public function receivedMessages()
    {
    return $this->hasMany(Chat::class, 'receiver_id');
    }

    // ============ RELATIONSHIPS ============
    public function moodCheckins()
    {
        return $this->hasMany(MoodCheckin::class);
    }

    public function latestMoodCheckin()
    {
        return $this->hasOne(MoodCheckin::class)->latestOfMany();
    }

    public function friendships()
    {
        return $this->hasMany(Friendship::class, 'user_id');
    }

    public function subscriptions()
    {
        return $this->hasMany(Subscription::class);
    }

    public function activeSubscription()
    {
        return $this->hasOne(Subscription::class)->where('status', 'active')->latest();
    }

    public function settings()
    {
        return $this->hasOne(UserSetting::class);
    }

    // ============ METHODS ============
    
    /**
     * Check if user is premium and subscription is still valid
     */
    public function isPremium()
    {
        // Cek is_premium dan premium_expiry
        if ($this->is_premium && $this->premium_expiry) {
            return $this->premium_expiry->isFuture();
        }
        return false;
    }

    /**
     * Calculate user's streak
     */
    public function getStreakAttribute()
    {
        $dates = $this->moodCheckins()
            ->selectRaw('DISTINCT DATE(created_at) as checkin_date')
            ->orderBy('checkin_date', 'desc')
            ->pluck('checkin_date');

        if ($dates->isEmpty()) {
            return 0;
        }

        $streak = 0;
        $expectedDate = now()->format('Y-m-d');

        foreach ($dates as $date) {
            if ($date === $expectedDate) {
                $streak++;
                $expectedDate = \Carbon\Carbon::parse($expectedDate)->subDay()->format('Y-m-d');
            } elseif ($date < $expectedDate) {
                break;
            }
        }

        return $streak;
    }

    /**
     * Get user settings
     */
    public function getSettings()
    {
        if (!$this->settings) {
            $this->settings()->create([]);
            $this->load('settings');
        }
        return $this->settings;
    }

    public function isFriendWith($friendId)
    {
        return Friendship::where(function ($q) use ($friendId) {
            $q->where('user_id', $this->id)
              ->where('friend_id', $friendId)
              ->where('status', 'accepted');
        })->orWhere(function ($q) use ($friendId) {
            $q->where('user_id', $friendId)
              ->where('friend_id', $this->id)
              ->where('status', 'accepted');
        })->exists();
    }
}