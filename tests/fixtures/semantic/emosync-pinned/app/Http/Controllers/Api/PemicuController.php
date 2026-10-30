<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Pemicu;
use Illuminate\Support\Facades\Cache;

class PemicuController extends Controller
{
    public function index()
    {
        $pemicus = Pemicu::all();

        return response()->json([
            'success' => true,
            'data' => $pemicus,
        ]);
    }
}