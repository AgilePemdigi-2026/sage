<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Models\Content;

class DashboardController extends Controller
{
    public function index()
    {
        $totalKonten = Content::count();
        $totalArtikel = Content::where('type', 'ARTIKEL')->count();
        $totalVideo = Content::where('type', 'VIDEO')->count();
        $totalKutipan = Content::where('type', 'KUTIPAN')->count();
        $kontenTerbaru = Content::latest()->take(5)->get();

        return response()->json([
            'success' => true,
            'data' => [
                'total_konten' => $totalKonten,
                'total_artikel' => $totalArtikel,
                'total_video' => $totalVideo,
                'total_kutipan' => $totalKutipan,
                'konten_terbaru' => $kontenTerbaru,
            ],
        ]);
    }
}
