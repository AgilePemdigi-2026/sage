<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Subscription;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class PremiumController extends Controller
{
    /**
     * Get user's premium status
     */
    public function status(Request $request)
    {
        $user = $request->user();

        return response()->json([
            'success' => true,
            'data' => [
                'is_premium' => $user->isPremium(),
                'plan' => $user->premium_plan,
                'expires_at' => $user->premium_expiry,
            ]
        ]);
    }

    /**
     * Get available premium plans
     */
    public function plans()
    {
        $plans = [
            [
                'id' => 'monthly',
                'name' => 'Monthly Access',
                'price' => 9900,
                'price_formatted' => 'Rp 9.900',
                'period' => '/ bulan',
                'duration_days' => 30,
            ],
            [
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

        return response()->json([
            'success' => true,
            'data' => $plans
        ]);
    }

    /**
     * Subscribe to premium plan
     */
    public function subscribe(Request $request)
    {
        $request->validate([
            'plan' => 'required|in:monthly,yearly',
            'payment_method' => 'required|string',
        ]);

        $user = $request->user();
        $plan = $request->plan;
        $durationDays = $plan === 'yearly' ? 365 : 30;
        $expiresAt = $user->premium_expiry?->isFuture()
            ? $user->premium_expiry->copy()->addDays($durationDays)
            : now()->addDays($durationDays);

        DB::beginTransaction();
        
        try {
            // Cancel any existing active subscription
            Subscription::where('user_id', $user->id)
                ->where('status', 'active')
                ->update(['status' => 'cancelled']);
            
            // Create new subscription
            Subscription::create([
                'user_id' => $user->id,
                'plan' => $plan,
                'status' => 'active',
                'expires_at' => $expiresAt,
            ]);

            // Update user as premium
            $user->update([
                'is_premium' => true,
                'premium_plan' => $plan,
                'premium_expiry' => $expiresAt,
            ]);
            
            DB::commit();

            return response()->json([
                'success' => true,
                'message' => 'Subscription successful',
                'data' => [
                    'is_premium' => true,
                    'plan' => $plan,
                    'expires_at' => $expiresAt,
                ]
            ]);
        } catch (\Exception $e) {
            DB::rollBack();
            return response()->json([
                'success' => false,
                'message' => 'Subscription failed: ' . $e->getMessage()
            ], 500);
        }
    }

    /**
     * Cancel premium subscription
     */
    public function cancel(Request $request)
    {
        $user = $request->user();
        
        DB::beginTransaction();
        
        try {
            // Cancel active subscription
            $subscription = $user->activeSubscription;
            
            if ($subscription) {
                $subscription->update(['status' => 'cancelled']);
            }
            
            // Remove premium status from user
            $user->update([
                'is_premium' => false,
                'premium_plan' => null,
                'premium_expiry' => null,
            ]);
            
            DB::commit();

            return response()->json([
                'success' => true,
                'message' => 'Subscription cancelled'
            ]);
        } catch (\Exception $e) {
            DB::rollBack();
            return response()->json([
                'success' => false,
                'message' => 'Failed to cancel subscription'
            ], 500);
        }
    }
}