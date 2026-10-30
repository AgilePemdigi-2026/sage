<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class Transaction extends Model
{
    use HasFactory;

    protected $fillable = [
        'user_id',
        'transaction_id',
        'plan',
        'amount',
        'payment_method',
        'status',
        'virtual_account',
        'expires_at',
        'paid_at',
        'metadata',
    ];

    protected $casts = [
        'expires_at' => 'datetime',
        'paid_at' => 'datetime',
        'metadata' => 'array',
    ];

    // ============ RELATIONSHIPS ============
    
    public function user()
    {
        return $this->belongsTo(User::class);
    }

    // ============ SCOPES ============
    
    public function scopePending($query)
    {
        return $query->where('status', 'pending');
    }

    public function scopeSuccess($query)
    {
        return $query->where('status', 'success');
    }

    public function scopeFailed($query)
    {
        return $query->where('status', 'failed');
    }

    // ============ HELPERS ============
    
    public function isExpired()
    {
        if (!$this->expires_at) return false;
        return $this->expires_at->isPast();
    }

    public function getStatusLabel()
    {
        return match($this->status) {
            'pending' => 'Menunggu Pembayaran',
            'success' => 'Berhasil ✅',
            'failed' => 'Gagal ❌',
            default => $this->status,
        };
    }

    public function getStatusColor()
    {
        return match($this->status) {
            'pending' => 'warning',
            'success' => 'success',
            'failed' => 'danger',
            default => 'secondary',
        };
    }
}