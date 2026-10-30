<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\MoodCheckin;
use Illuminate\Http\Request;

class DukunganController extends Controller
{
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

    public function index(Request $request)
    {
        $user = $request->user();

        $latest = MoodCheckin::where('user_id', $user->id)
            ->latest()
            ->first();

        if (!$latest) {
            return response()->json([
                'level' => 'awal',
                'message' => 'Yuk mulai tracking mood kamu!',
                'saran' => []
            ]);
        }

        $kritis = MoodCheckin::where('user_id', $user->id)
            ->where('created_at', '>=', now()->subDays(7))
            ->where(function ($query) {
                $query->where('mood', 'sad')
                      ->orWhere('mood', 'anxious');
            })
            ->count();

        if ($kritis >= 5) {
            $level = 'profesional';
            $message = "Kamu sudah {$kritis}x di zona tidak nyaman. Jangan ragu cari bantuan ya.";
        } elseif ($kritis >= 3) {
            $level = 'ringan';
            $message = "Kamu sudah {$kritis}x di zona tidak nyaman. Coba saran berikut.";
        } elseif (in_array($latest->mood, ['sad', 'anxious'])) {
            $level = 'ringan';
            $message = 'Sepertinya kamu sedang tidak nyaman. Coba tips ini.';
        } else {
            $level = 'aman';
            $message = 'Mood kamu stabil! Tetap jaga kesehatan mental.';
        }

        $saran = $this->getSaran($level);

        return response()->json([
            'level' => $level,
            'message' => $message,
            'checkin_terakhir' => $this->moodToKuadran($latest->mood),
            'frekuensi_kritis' => $kritis,
            'saran' => $saran,
        ]);
    }

    private function getSaran($level)
    {
        if ($level === 'profesional') {
            return [
                ['tipe' => 'konsultasi', 'judul' => 'Konsultasi Psikolog', 'deskripsi' => 'Jangan ragu cari bantuan profesional.', 'ikon' => '🧠'],
                ['tipe' => 'hotline', 'judul' => 'Hotline 119', 'deskripsi' => 'Layanan darurat kesehatan mental.', 'ikon' => '📞'],
            ];
        }

        if ($level === 'ringan') {
            return [
                ['tipe' => 'minum_air', 'judul' => 'Minum Air', 'deskripsi' => 'Dehidrasi bikin mood buruk.', 'ikon' => '💧'],
                ['tipe' => 'napas', 'judul' => 'Tarik Napas', 'deskripsi' => 'Tenangkan pikiranmu.', 'ikon' => '🫁'],
                ['tipe' => 'istirahat', 'judul' => 'Rehat Sejenak', 'deskripsi' => 'Jauh dari layar 10 menit.', 'ikon' => '📱'],
            ];
        }

        return [
            ['tipe' => 'maintain', 'judul' => 'Pertahankan!', 'deskripsi' => 'Lakukan hal positif.', 'ikon' => '🌟'],
        ];
    }
}