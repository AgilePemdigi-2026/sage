<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Transaction;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Validator;
use Illuminate\Support\Str;

class PaymentController extends Controller
{
    // ============ PLAN PRICING ============
    private function getPlansData()
    {
        return [
            'monthly' => [
                'id' => 'monthly',
                'name' => 'Monthly Access',
                'price' => 9900,
                'price_formatted' => 'Rp 9.900',
                'period' => '/ bulan',
                'duration_days' => 30,
                'badge' => null,
                'saving' => null,
            ],
            'yearly' => [
                'id' => 'yearly',
                'name' => 'Yearly Access',
                'price' => 99900,
                'price_formatted' => 'Rp 99.900',
                'period' => '/ tahun',
                'duration_days' => 365,
                'badge' => 'BEST VALUE',
                'saving' => 'Hemat 16%',
            ],
        ];
    }

    // ============ GET PLANS ============
    public function getPlans()
    {
        return response()->json([
            'success' => true,
            'data' => array_values($this->getPlansData())
        ]);
    }

    // ============ CREATE TRANSACTION ============
    public function createTransaction(Request $request)
    {
        $user = Auth::user();

        $validator = Validator::make($request->all(), [
            'plan' => 'required|in:monthly,yearly',
            'payment_method' => 'required|in:qris,bca,mandiri,bni',
        ]);

        if ($validator->fails()) {
            return response()->json([
                'success' => false,
                'message' => 'Validasi gagal',
                'errors' => $validator->errors()
            ], 422);
        }

        $planId = $request->plan;
        $plans = $this->getPlansData();
        $plan = $plans[$planId] ?? null;

        if (!$plan) {
            return response()->json([
                'success' => false,
                'message' => 'Paket tidak valid'
            ], 400);
        }

        // Cek apakah sudah punya transaksi pending
        $pendingTransaction = Transaction::where('user_id', $user->id)
            ->where('status', 'pending')
            ->where('expires_at', '>', now())
            ->first();

        if ($pendingTransaction) {
            return response()->json([
                'success' => false,
                'message' => 'Anda memiliki transaksi pending. Selesaikan atau batalkan terlebih dahulu.',
                'data' => [
                    'transaction_id' => $pendingTransaction->transaction_id,
                    'expires_at' => $pendingTransaction->expires_at,
                ]
            ], 400);
        }

        // Generate transaction ID
        $transactionId = 'TRX-' . strtoupper(Str::random(12));
        
        // Generate virtual account
        $virtualAccount = $this->generateVirtualAccount($request->payment_method);

        // Create transaction
        $transaction = Transaction::create([
            'user_id' => $user->id,
            'transaction_id' => $transactionId,
            'plan' => $planId,
            'amount' => $plan['price'],
            'payment_method' => $request->payment_method,
            'status' => 'pending',
            'virtual_account' => $virtualAccount,
            'expires_at' => Carbon::now()->addMinutes(60),
            'metadata' => [
                'plan_name' => $plan['name'],
                'duration_days' => $plan['duration_days'],
            ]
        ]);

        return response()->json([
            'success' => true,
            'message' => 'Transaksi berhasil dibuat',
            'data' => [
                'transaction_id' => $transaction->transaction_id,
                'amount' => $transaction->amount,
                'amount_formatted' => 'Rp ' . number_format($transaction->amount, 0, ',', '.'),
                'virtual_account' => $transaction->virtual_account,
                'payment_method' => $transaction->payment_method,
                'expires_at' => $transaction->expires_at->toISOString(),
                'expires_in' => $transaction->expires_at->diffInMinutes(now()),
                'status' => $transaction->status,
                'instruction' => $this->getPaymentInstruction($transaction->payment_method),
            ]
        ], 201);
    }

    // ============ CHECK TRANSACTION STATUS ============
    public function checkTransaction($transactionId)
    {
        $user = Auth::user();

        $transaction = Transaction::where('transaction_id', $transactionId)
            ->where('user_id', $user->id)
            ->first();

        if (!$transaction) {
            return response()->json([
                'success' => false,
                'message' => 'Transaksi tidak ditemukan'
            ], 404);
        }

        // Jika transaksi pending dan sudah expired
        if ($transaction->status == 'pending' && $transaction->expires_at && $transaction->expires_at->isPast()) {
            $transaction->status = 'failed';
            $transaction->save();
        }

        return response()->json([
            'success' => true,
            'data' => [
                'transaction_id' => $transaction->transaction_id,
                'status' => $transaction->status,
                'status_label' => $this->getStatusLabel($transaction->status),
                'amount' => $transaction->amount,
                'amount_formatted' => 'Rp ' . number_format($transaction->amount, 0, ',', '.'),
                'virtual_account' => $transaction->virtual_account,
                'payment_method' => $transaction->payment_method,
                'expires_at' => $transaction->expires_at?->toISOString(),
                'paid_at' => $transaction->paid_at?->toISOString(),
                'plan' => $transaction->plan,
            ]
        ]);
    }

    // ============ SIMULATE PAYMENT (DEMO) ============
    public function simulatePayment($transactionId)
    {
        $user = Auth::user();

        $transaction = Transaction::where('transaction_id', $transactionId)
            ->where('user_id', $user->id)
            ->first();

        if (!$transaction) {
            return response()->json([
                'success' => false,
                'message' => 'Transaksi tidak ditemukan'
            ], 404);
        }

        if ($transaction->status != 'pending') {
            return response()->json([
                'success' => false,
                'message' => 'Transaksi sudah ' . $transaction->status
            ], 400);
        }

        if ($transaction->expires_at && $transaction->expires_at->isPast()) {
            $transaction->status = 'failed';
            $transaction->save();
            return response()->json([
                'success' => false,
                'message' => 'Transaksi sudah expired',
                'data' => ['status' => 'failed']
            ], 400);
        }

        // Simulasi pembayaran berhasil
        $transaction->status = 'success';
        $transaction->paid_at = now();
        $transaction->save();

        // Update user ke premium
        $user = User::find($transaction->user_id);
        $durationDays = $transaction->metadata['duration_days'] ?? 30;
        $expiryDate = $user->premium_expiry?->isFuture()
            ? $user->premium_expiry->copy()->addDays($durationDays)
            : Carbon::now()->addDays($durationDays);
        
        $user->is_premium = true;
        $user->premium_plan = $transaction->plan;
        $user->premium_expiry = $expiryDate;
        $user->save();

        return response()->json([
            'success' => true,
            'message' => 'Pembayaran berhasil! Selamat, Anda sekarang premium user! 🎉',
            'data' => [
                'transaction_id' => $transaction->transaction_id,
                'status' => 'success',
                'paid_at' => $transaction->paid_at->toISOString(),
                'premium_expiry' => $expiryDate->toISOString(),
                'user' => [
                    'id' => $user->id,
                    'name' => $user->name,
                    'is_premium' => true,
                    'premium_plan' => $user->premium_plan,
                    'premium_expiry' => $user->premium_expiry,
                ]
            ]
        ]);
    }

    // ============ CANCEL TRANSACTION ============
    public function cancelTransaction($transactionId)
    {
        $user = Auth::user();

        $transaction = Transaction::where('transaction_id', $transactionId)
            ->where('user_id', $user->id)
            ->where('status', 'pending')
            ->first();

        if (!$transaction) {
            return response()->json([
                'success' => false,
                'message' => 'Transaksi tidak ditemukan atau sudah selesai'
            ], 404);
        }

        $transaction->status = 'failed';
        $transaction->save();

        return response()->json([
            'success' => true,
            'message' => 'Transaksi dibatalkan'
        ]);
    }

    // ============ GET USER TRANSACTIONS ============
    public function getUserTransactions()
    {
        $user = Auth::user();

        $transactions = Transaction::where('user_id', $user->id)
            ->orderBy('created_at', 'desc')
            ->get();

        return response()->json([
            'success' => true,
            'data' => $transactions->map(function($transaction) {
                return [
                    'id' => $transaction->id,
                    'transaction_id' => $transaction->transaction_id,
                    'plan' => $transaction->plan,
                    'plan_label' => $transaction->plan == 'yearly' ? 'Yearly' : 'Monthly',
                    'amount' => $transaction->amount,
                    'amount_formatted' => 'Rp ' . number_format($transaction->amount, 0, ',', '.'),
                    'payment_method' => $transaction->payment_method,
                    'status' => $transaction->status,
                    'status_label' => $this->getStatusLabel($transaction->status),
                    'created_at' => $transaction->created_at->toISOString(),
                    'paid_at' => $transaction->paid_at?->toISOString(),
                ];
            })
        ]);
    }

    // ============ HELPERS ============
    
    private function getStatusLabel($status)
    {
        return match($status) {
            'pending' => 'Menunggu Pembayaran',
            'success' => 'Berhasil ✅',
            'failed' => 'Gagal ❌',
            default => $status,
        };
    }
    
    private function generateVirtualAccount($method)
    {
        $prefix = match($method) {
            'bca' => '888',
            'mandiri' => '889',
            'bni' => '890',
            'qris' => null,
            default => null,
        };
        
        if ($prefix) {
            return $prefix . str_pad(rand(100000000, 999999999), 9, '0', STR_PAD_LEFT);
        }
        
        return 'QRIS-' . strtoupper(Str::random(8));
    }

    private function getPaymentInstruction($method)
    {
        $instructions = [
            'qris' => [
                'title' => 'Scan QRIS',
                'steps' => [
                    'Buka aplikasi mobile banking atau e-wallet',
                    'Pilih menu Scan QRIS',
                    'Scan QR Code yang muncul',
                    'Konfirmasi pembayaran',
                    'Transaksi akan otomatis terverifikasi',
                ]
            ],
            'bca' => [
                'title' => 'Transfer ke BCA Virtual Account',
                'steps' => [
                    'Buka aplikasi BCA mobile atau ATM',
                    'Pilih menu Transfer',
                    'Pilih Virtual Account BCA',
                    'Masukkan nomor Virtual Account yang tertera',
                    'Masukkan nominal sesuai tagihan',
                    'Konfirmasi pembayaran',
                ]
            ],
            'mandiri' => [
                'title' => 'Transfer ke Mandiri Virtual Account',
                'steps' => [
                    'Buka aplikasi Mandiri mobile atau ATM',
                    'Pilih menu Transfer',
                    'Pilih Virtual Account Mandiri',
                    'Masukkan nomor Virtual Account yang tertera',
                    'Masukkan nominal sesuai tagihan',
                    'Konfirmasi pembayaran',
                ]
            ],
            'bni' => [
                'title' => 'Transfer ke BNI Virtual Account',
                'steps' => [
                    'Buka aplikasi BNI mobile atau ATM',
                    'Pilih menu Transfer',
                    'Pilih Virtual Account BNI',
                    'Masukkan nomor Virtual Account yang tertera',
                    'Masukkan nominal sesuai tagihan',
                    'Konfirmasi pembayaran',
                ]
            ],
        ];

        return $instructions[$method] ?? $instructions['qris'];
    }
}