<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\Request;
use Carbon\Carbon;
use Illuminate\Support\Facades\DB;

class ReportController extends Controller
{
    /**
     * Get weekly report for the user
     * 
     * GET /api/reports/weekly
     */
    public function weekly(Request $request)
    {
        $user = $request->user();
        
        $startDate = Carbon::now()->subDays(7)->startOfDay();
        $endDate = Carbon::now()->endOfDay();

        // Get user's checkins for the last 7 days
        $checkins = $user->moodCheckins()
            ->whereBetween('created_at', [$startDate, $endDate])
            ->with('pemicus')
            ->get();

        $totalCheckins = $checkins->count();

        // Calculate mood percentages
        $moodCounts = $checkins->groupBy('mood')->map->count();
        $moodPercentages = [];
        foreach ($moodCounts as $mood => $count) {
            $moodPercentages[$mood] = $totalCheckins > 0 ? round(($count / $totalCheckins) * 100) : 0;
        }
        
        // Sort by percentage descending
        arsort($moodPercentages);

        // Get top triggers (pemicus)
        $pemicuCounts = [];
        $pemicuDetails = [];
        foreach ($checkins as $checkin) {
            foreach ($checkin->pemicus as $pemicu) {
                if (!isset($pemicuCounts[$pemicu->id])) {
                    $pemicuCounts[$pemicu->id] = 0;
                    $pemicuDetails[$pemicu->id] = [
                        'id' => $pemicu->id,
                        'nama' => $pemicu->nama,
                        'ikon' => $pemicu->ikon,
                        'kategori' => $pemicu->kategori
                    ];
                }
                $pemicuCounts[$pemicu->id]++;
            }
        }
        
        arsort($pemicuCounts);
        $topPemicus = [];
        $limit = 5; // Get top 5 triggers
        $i = 0;
        foreach ($pemicuCounts as $id => $count) {
            if ($i >= $limit) break;
            $detail = $pemicuDetails[$id];
            $detail['count'] = $count;
            $topPemicus[] = $detail;
            $i++;
        }

        return response()->json([
            'success' => true,
            'data' => [
                'period' => [
                    'start' => $startDate->format('Y-m-d'),
                    'end' => $endDate->format('Y-m-d'),
                ],
                'total_checkins' => $totalCheckins,
                'streak' => $user->streak,
                'mood_percentages' => $moodPercentages,
                'top_triggers' => $topPemicus,
            ]
        ]);
    }
}
