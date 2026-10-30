<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\MoodCheckin;
use Illuminate\Http\Request;

class DashboardController extends Controller
{
    // Mapping mood ke kuadran
    private function moodToKuadran($mood)
    {
        return match ($mood) {
            'happy' => 'high_energy_pleasant',
            'anxious' => 'high_energy_unpleasant',
            'calm' => 'low_energy_pleasant',
            'sad' => 'low_energy_unpleasant',
            default => 'low_energy_pleasant',
        };
    }

    // Mapping kuadran ke mood frontend
    private function mapKuadranToMood($kuadran)
    {
        return match ($kuadran) {
            'high_energy_pleasant' => 'Happy',
            'high_energy_unpleasant' => 'Anxious',
            'low_energy_pleasant' => 'Calm',
            'low_energy_unpleasant' => 'Sad',
            default => 'Calm',
        };
    }

    public function index(Request $request)
    {
        $user = $request->user();

        // Total check-in
        $totalCheckin = MoodCheckin::where('user_id', $user->id)->count();

        // 7 hari terakhir
        $tujuhHari = MoodCheckin::where('user_id', $user->id)
            ->where('created_at', '>=', now()->subDays(7))
            ->get();

        // Streak
        $streak = $user->streak;

        // Data untuk chart (7 hari terakhir dengan mapping mood)
        $weeklyData = [];
        for ($i = 6; $i >= 0; $i--) {
            $date = now()->subDays($i);
            $checkin = MoodCheckin::where('user_id', $user->id)
                ->whereDate('created_at', $date->toDateString())
                ->first();

            $weeklyData[] = [
                'day' => $this->getDayName($date->dayOfWeek),
                'date' => $date->toDateString(),
                'mood' => $checkin ? $this->mapKuadranToMood($this->moodToKuadran($checkin->mood)) : null,
                'hasChecked' => $checkin ? true : false,
            ];
        }

        // Mood dominan (paling sering muncul dalam 7 hari)
        $moodCount = [];
        foreach ($tujuhHari as $checkin) {
            $mood = $this->mapKuadranToMood($this->moodToKuadran($checkin->mood));
            $moodCount[$mood] = ($moodCount[$mood] ?? 0) + 1;
        }
        $dominantMood = !empty($moodCount) ? array_keys($moodCount, max($moodCount))[0] : null;

        return response()->json([
            'success' => true,
            'data' => [
                'total_checkin' => $totalCheckin,
                'streak' => $streak,
                'dominant_mood' => $dominantMood,
                'weekly_data' => $weeklyData,
                'has_checked_today' => MoodCheckin::where('user_id', $user->id)
                    ->whereDate('created_at', now()->toDateString())
                    ->exists(),
            ],
        ]);
    }

    private function getDayName($dayOfWeek)
    {
        return match ($dayOfWeek) {
            1 => 'Sen',
            2 => 'Sel',
            3 => 'Rab',
            4 => 'Kam',
            5 => 'Jum',
            6 => 'Sab',
            7 => 'Min',
            default => '',
        };
    }
}