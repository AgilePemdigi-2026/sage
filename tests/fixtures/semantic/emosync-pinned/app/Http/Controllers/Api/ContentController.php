<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Content;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;

class ContentController extends Controller
{
    // Get all contents (with premium check)
    public function index(Request $request)
    {
        try {
            $user = Auth::user();
            $isPremium = false;
            
            if ($user) {
                $isPremium = $user->isPremium();
            }

            $cacheKey = 'contents_v2_' . ($isPremium ? 'premium' : 'free');
            
            $result = Cache::remember($cacheKey, 3600, function () use ($isPremium) {
                $contents = Content::paginate(20);

                $formattedContents = $contents->map(function($content) use ($isPremium) {
                    $isLocked = $content->is_premium && !$isPremium;
                    return [
                        'id' => $content->id,
                        'title' => $content->title,
                        'description' => $content->description,
                        'full_content' => $isLocked ? null : $content->full_content,
                        'type' => $content->type,
                        'thumbnail_url' => $content->thumbnail_url,
                        'video_url' => $isLocked ? null : $content->video_url,
                        'is_premium' => $content->is_premium,
                        'is_locked' => $isLocked,
                    ];
                })->values()->toArray();

                return [
                    'data' => $formattedContents,
                    'pagination' => [
                        'current_page' => $contents->currentPage(),
                        'last_page' => $contents->lastPage(),
                        'per_page' => $contents->perPage(),
                        'total' => $contents->total(),
                        'next_page_url' => $contents->nextPageUrl(),
                        'prev_page_url' => $contents->previousPageUrl(),
                    ]
                ];
            });

            return response()->json(array_merge(['success' => true], $result));
            
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Gagal mengambil konten: ' . $e->getMessage()
            ], 500);
        }
    }

    // Get single content detail
    public function show($id)
    {
        try {
            $content = Content::find($id);
            
            if (!$content) {
                return response()->json([
                    'success' => false,
                    'message' => 'Konten tidak ditemukan'
                ], 404);
            }
            
            $user = Auth::user();
            $isPremium = false;
            
            if ($user) {
                $isPremium = $user->isPremium();
            }
            
            // Jika konten premium dan user tidak premium
            if ($content->is_premium && !$isPremium) {
                return response()->json([
                    'success' => false,
                    'message' => 'Konten ini hanya untuk pengguna premium',
                    'is_locked' => true
                ], 403);
            }
            
            return response()->json([
                'success' => true,
                'data' => [
                    'id' => $content->id,
                    'title' => $content->title,
                    'description' => $content->description,
                    'full_content' => $content->full_content,
                    'type' => $content->type,
                    'thumbnail_url' => $content->thumbnail_url,
                    'video_url' => $content->video_url,
                    'is_premium' => $content->is_premium,
                ]
            ]);
            
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Gagal mengambil detail konten: ' . $e->getMessage()
            ], 500);
        }
    }
}