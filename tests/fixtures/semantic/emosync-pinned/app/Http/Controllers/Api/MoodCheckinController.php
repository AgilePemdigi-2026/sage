<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\MoodCheckin;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class MoodCheckinController extends Controller
{
    public function index(Request $request)
    {
        $user = $request->user();
        $checkins = $user->moodCheckins()
            ->with(['pemicus' => function($query) {
                $query->select('pemicus.id', 'pemicus.nama');
            }])
            ->orderBy('created_at', 'desc')
            ->limit(30)
            ->get();

        return response()->json([
            'success' => true,
            'data' => $checkins
        ]);
    }

    public function store(Request $request)
    {
        $request->validate([
            'mood' => 'required|string|in:happy,anxious,calm,sad',
            'catatan' => 'nullable|string|max:500',
            'pemicu_ids' => 'nullable|array',
            'pemicu_ids.*' => 'exists:pemicus,id',
        ]);

        $user = $request->user();
        
        // Cek apakah sudah check-in hari ini
        $hasCheckedToday = MoodCheckin::where('user_id', $user->id)
            ->whereDate('created_at', today())
            ->exists();
        
        if ($hasCheckedToday) {
            return response()->json([
                'success' => false,
                'message' => 'Anda sudah melakukan check-in hari ini'
            ], 422);
        }

        DB::beginTransaction();
        
        try {
            $checkin = MoodCheckin::create([
                'user_id' => $user->id,
                'mood' => $request->mood,
                'catatan' => $request->catatan,
            ]);

            if ($request->has('pemicu_ids')) {
                $checkin->pemicus()->attach($request->pemicu_ids);
            }
            
            DB::commit();

            return response()->json([
                'success' => true,
                'data' => $checkin->load('pemicus')
            ], 201);
        } catch (\Exception $e) {
            DB::rollBack();
            return response()->json([
                'success' => false,
                'message' => 'Gagal menyimpan check-in'
            ], 500);
        }
    }

    public function dashboard(Request $request)
    {
        $user = $request->user();
        $userId = $user->id;

        $streak = $user->streak;

        $weeklyCheckins = $user->moodCheckins()
            ->where('created_at', '>=', now()->subDays(7))
            ->orderBy('created_at', 'asc')
            ->get(['id', 'mood', 'catatan', 'created_at']);

        $moodDistribution = MoodCheckin::where('user_id', $userId)
            ->select('mood', DB::raw('count(*) as count'))
            ->groupBy('mood')
            ->pluck('count', 'mood')
            ->toArray();

        $averageMood = $this->calculateAverageMood($userId);

        return response()->json([
            'success' => true,
            'data' => [
                'streak' => $streak,
                'rata_rata_mood' => $averageMood,
                'mood_distribution' => $moodDistribution,
                'weekly_checkins' => $weeklyCheckins,
            ]
        ]);
    }


    private function calculateAverageMood($userId)
    {
        $result = DB::table('mood_checkins')
            ->where('user_id', $userId)
            ->select(DB::raw("AVG(CASE 
                WHEN mood = 'happy' THEN 4
                WHEN mood = 'calm' THEN 3
                WHEN mood = 'anxious' THEN 2
                WHEN mood = 'sad' THEN 1
                ELSE 0
            END) as average"))
            ->first();

        return $result->average ? round($result->average, 1) : 0;
    }
}