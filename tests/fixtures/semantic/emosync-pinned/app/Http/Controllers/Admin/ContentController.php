<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Models\Content;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

class ContentController extends Controller
{
    public function index(Request $request)
    {
        $query = Content::query();

        if ($request->search) {
            $query->where('title', 'like', "%{$request->search}%");
        }

        if ($request->type) {
            $query->where('type', $request->type);
        }

        $contents = $query->latest()->paginate(20);

        return response()->json([
            'success' => true,
            'data' => $contents->items(),
            'pagination' => [
                'current_page' => $contents->currentPage(),
                'last_page' => $contents->lastPage(),
                'per_page' => $contents->perPage(),
                'total' => $contents->total(),
            ],
        ]);
    }

    public function show($id)
    {
        $content = Content::find($id);

        if (!$content) {
            return response()->json([
                'success' => false,
                'message' => 'Konten tidak ditemukan.',
            ], 404);
        }

        return response()->json([
            'success' => true,
            'data' => $content,
        ]);
    }

    public function store(Request $request)
    {
        $validated = $request->validate([
            'title' => 'required|string|max:255',
            'description' => 'nullable|string',
            'full_content' => 'nullable|string',
            'type' => 'required|in:ARTIKEL,VIDEO,KUTIPAN',
            'thumbnail_url' => 'nullable|string|max:500',
            'video_url' => 'nullable|string|max:500',
            'is_premium' => 'boolean',
        ]);

        $content = Content::create($validated);

        Cache::forget('contents_all_premium');
        Cache::forget('contents_all_free');

        return response()->json([
            'success' => true,
            'message' => 'Konten berhasil dibuat.',
            'data' => $content,
        ], 201);
    }

    public function update(Request $request, $id)
    {
        $content = Content::find($id);

        if (!$content) {
            return response()->json([
                'success' => false,
                'message' => 'Konten tidak ditemukan.',
            ], 404);
        }

        $validated = $request->validate([
            'title' => 'required|string|max:255',
            'description' => 'nullable|string',
            'full_content' => 'nullable|string',
            'type' => 'required|in:ARTIKEL,VIDEO,KUTIPAN',
            'thumbnail_url' => 'nullable|string|max:500',
            'video_url' => 'nullable|string|max:500',
            'is_premium' => 'boolean',
        ]);

        $content->update($validated);

        Cache::forget('contents_all_premium');
        Cache::forget('contents_all_free');

        return response()->json([
            'success' => true,
            'message' => 'Konten berhasil diperbarui.',
            'data' => $content,
        ]);
    }

    public function destroy($id)
    {
        $content = Content::find($id);

        if (!$content) {
            return response()->json([
                'success' => false,
                'message' => 'Konten tidak ditemukan.',
            ], 404);
        }

        // Hapus file dari Supabase Storage
        if ($content->thumbnail_url) {
            $thumbnailPath = $this->extractPath($content->thumbnail_url);
            if ($thumbnailPath) {
                Storage::disk('supabase')->delete($thumbnailPath);
            }
        }
        if ($content->video_url) {
            $videoPath = $this->extractPath($content->video_url);
            if ($videoPath) {
                Storage::disk('supabase')->delete($videoPath);
            }
        }

        $content->delete();

        Cache::forget('contents_all_premium');
        Cache::forget('contents_all_free');

        return response()->json([
            'success' => true,
            'message' => 'Konten berhasil dihapus.',
        ]);
    }

    public function upload(Request $request)
    {
        $request->validate([
            'file' => 'required|file|max:102400',
            'type' => 'required|in:thumbnail,video',
        ]);

        $file = $request->file('file');
        $type = $request->type;

        $allowedMimes = $type === 'thumbnail'
            ? ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
            : ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'];

        if (!in_array($file->getMimeType(), $allowedMimes)) {
            return response()->json([
                'success' => false,
                'message' => 'Tipe file tidak didukung.',
            ], 422);
        }

        $folder = $type === 'thumbnail' ? 'thumbnails' : 'videos';
        $filename = Str::uuid() . '.' . $file->getClientOriginalExtension();

        $path = $file->storeAs("contents/{$folder}", $filename, 'supabase');

        if (!$path) {
            return response()->json([
                'success' => false,
                'message' => 'Gagal mengupload file.',
            ], 500);
        }

        $url = Storage::disk('supabase')->url($path);

        return response()->json([
            'success' => true,
            'data' => [
                'url' => $url,
                'path' => $path,
            ],
        ]);
    }

    private function extractPath(string $url): ?string
    {
        $disk = Storage::disk('supabase');
        $baseUrl = rtrim($disk->url('/'), '/');

        $path = str_replace($baseUrl . '/', '', $url);
        return $path !== $url ? $path : null;
    }
}
