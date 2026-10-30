<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\User;
use App\Models\Friendship;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Validator;

class FriendshipController extends Controller
{
    // ============ GET FRIENDS LIST ============
    public function index()
    {
        $user = Auth::user();

        $friendIds = Friendship::where('user_id', $user->id)
            ->where('status', 'accepted')
            ->pluck('friend_id')
            ->merge(
                Friendship::where('friend_id', $user->id)
                    ->where('status', 'accepted')
                    ->pluck('user_id')
            );

        $friends = User::whereIn('id', $friendIds)
            ->with('latestMoodCheckin')
            ->paginate(20);

        return response()->json([
            'success' => true,
            'data' => $friends->map(function($friend) {
                return [
                    'id' => $friend->id,
                    'name' => $friend->name,
                    'username' => $friend->username,
                    'email' => $friend->email,
                    'avatar' => $friend->avatar ?? 'male',
                    'is_premium' => $friend->isPremium(),
                    'mood' => $friend->latestMoodCheckin ? $friend->latestMoodCheckin->mood : null,
                    'last_checkin_at' => $friend->latestMoodCheckin ? $friend->latestMoodCheckin->created_at->diffForHumans() : null,
                ];
            })
        ]);
    }

    // ============ ADD FRIEND REQUEST ============
    public function add(Request $request)
    {
        $user = Auth::user();

        // Validasi input
        $validator = Validator::make($request->all(), [
            'username' => 'required|string|max:255'
        ]);

        if ($validator->fails()) {
            return response()->json([
                'success' => false,
                'message' => 'Username harus diisi',
                'errors' => $validator->errors()
            ], 422);
        }

        $userId = $user->id;
        
        // Cari user berdasarkan username
        $friend = User::where('username', $request->username)->first();
        
        if (!$friend) {
            return response()->json([
                'success' => false,
                'message' => 'Pengguna dengan username "' . $request->username . '" tidak ditemukan'
            ], 404);
        }
        
        $friendId = $friend->id;
        
        // Cek apakah mencoba berteman dengan diri sendiri
        if ($userId == $friendId) {
            return response()->json([
                'success' => false,
                'message' => 'Tidak bisa berteman dengan diri sendiri'
            ], 400);
        }
        
        // Cek apakah sudah ada hubungan pertemanan (dalam transaction)
        try {
            DB::beginTransaction();
            
            $existing = Friendship::where(function($query) use ($userId, $friendId) {
                $query->where('user_id', $userId)->where('friend_id', $friendId);
            })->orWhere(function($query) use ($userId, $friendId) {
                $query->where('user_id', $friendId)->where('friend_id', $userId);
            })->first();
            
            if ($existing) {
                DB::rollBack();
                if ($existing->status == 'pending') {
                    // Cek siapa yang mengirim
                    if ($existing->user_id == $userId) {
                        return response()->json([
                            'success' => false,
                            'message' => 'Permintaan pertemanan sudah Anda kirimkan ke @' . $friend->username
                        ], 400);
                    } else {
                        return response()->json([
                            'success' => false,
                            'message' => '@' . $friend->username . ' sudah mengirimkan permintaan pertemanan kepada Anda'
                        ], 400);
                    }
                } elseif ($existing->status == 'accepted') {
                    return response()->json([
                        'success' => false,
                        'message' => 'Anda sudah berteman dengan @' . $friend->username
                    ], 400);
                }
            }
            
            // Buat permintaan pertemanan
            $friendship = Friendship::create([
                'user_id' => $userId,
                'friend_id' => $friendId,
                'status' => 'pending'
            ]);
            
            DB::commit();


        } catch (\Exception $e) {
            DB::rollBack();
            return response()->json([
                'success' => false,
                'message' => 'Gagal mengirim permintaan pertemanan'
            ], 500);
        }
        
        return response()->json([
            'success' => true,
            'message' => 'Permintaan pertemanan terkirim ke @' . $friend->username,
            'data' => [
                'friendship_id' => $friendship->id,
                'friend' => [
                    'id' => $friend->id,
                    'name' => $friend->name,
                    'username' => $friend->username,
                    'avatar' => $friend->avatar ?? 'male',
                    'is_premium' => $friend->isPremium(),
                ]
            ]
        ], 201);
    }

    // ============ ACCEPT FRIEND REQUEST ============
    public function accept($id)
    {
        $user = Auth::user();
        
        $userId = $user->id;
        
        // Cari friendship berdasarkan id (friendship_id)
        $friendship = Friendship::find($id);
        
        if (!$friendship) {
            return response()->json([
                'success' => false,
                'message' => 'Permintaan pertemanan tidak ditemukan'
            ], 404);
        }
        
        // Validasi bahwa user ini adalah penerima (friend_id)
        if ($friendship->friend_id != $userId) {
            return response()->json([
                'success' => false,
                'message' => 'Anda tidak memiliki akses untuk menerima permintaan ini'
            ], 403);
        }
        
        // Cek status sudah pending
        if ($friendship->status != 'pending') {
            return response()->json([
                'success' => false,
                'message' => 'Permintaan ini sudah ' . $friendship->status
            ], 400);
        }
        
        $friendship->status = 'accepted';
        $friendship->save();

        // Kembalikan data user yang mengirim
        $friend = User::find($friendship->user_id);
        
        return response()->json([
            'success' => true,
            'message' => 'Permintaan pertemanan dari ' . $friend->name . ' diterima',
            'data' => [
                'id' => $friend->id,
                'name' => $friend->name,
                'username' => $friend->username,
                'email' => $friend->email,
                'avatar' => $friend->avatar ?? 'male',
            ]
        ]);
    }

    // ============ GET PENDING FRIEND REQUESTS ============
    public function requests()
    {
        $user = Auth::user();

        $userId = $user->id;

        $requests = Friendship::where(function($query) use ($userId) {
                $query->where('friend_id', $userId)
                      ->orWhere('user_id', $userId);
            })
            ->where('status', 'pending')
            ->get();

        $data = [];
        if ($requests->isNotEmpty()) {
            $otherUserIds = $requests->map(function ($req) use ($userId) {
                return ($userId == $req->friend_id) ? $req->user_id : $req->friend_id;
            });

            $otherUsers = User::whereIn('id', $otherUserIds)->get()->keyBy('id');

            foreach ($requests as $request) {
                $otherUserId = ($userId == $request->friend_id) ? $request->user_id : $request->friend_id;
                $otherUser = $otherUsers->get($otherUserId);

                if ($otherUser) {
                    $status = ($userId == $request->friend_id) ? 'incoming' : 'outgoing';

                    $data[] = [
                        'id' => $otherUser->id,
                        'name' => $otherUser->name,
                        'username' => $otherUser->username,
                        'email' => $otherUser->email,
                        'avatar' => $otherUser->avatar ?? 'male',
                        'is_premium' => $otherUser->isPremium(),
                        'friendship_id' => $request->id,
                        'status' => $status,
                    ];
                }
            }
        }

        return response()->json([
            'success' => true,
            'data' => $data
        ]);
    }

    // ============ SEARCH FRIENDS ============
    public function search(Request $request)
    {
        $user = Auth::user();

        $validator = Validator::make($request->all(), [
            'q' => 'required|string|min:2'
        ]);

        if ($validator->fails()) {
            return response()->json([
                'success' => false,
                'message' => 'Query pencarian minimal 2 karakter',
                'errors' => $validator->errors()
            ], 422);
        }
        
        $users = User::where(function($query) use ($request) {
            $query->where('name', 'like', '%' . $request->q . '%')
                  ->orWhere('username', 'like', '%' . $request->q . '%');
        })
            ->where('id', '!=', $user->id)
            ->limit(20)
            ->get();
        
        return response()->json([
            'success' => true,
            'data' => $users->map(function($user) {
                return [
                    'id' => $user->id,
                    'name' => $user->name,
                    'username' => $user->username,
                    'email' => $user->email,
                    'avatar' => $user->avatar ?? 'male',
                    'is_premium' => $user->isPremium(),
                ];
            })
        ]);
    }

    // ============ DELETE FRIEND / DECLINE REQUEST ============
    public function destroy($id)
    {
        $user = Auth::user();

        // Cari friendship (bisa accepted atau pending)
        $friendship = Friendship::where(function($query) use ($user, $id) {
            $query->where('user_id', $user->id)
                  ->where('friend_id', $id);
        })->orWhere(function($query) use ($user, $id) {
            $query->where('user_id', $id)
                  ->where('friend_id', $user->id);
        })->first();
        
        if (!$friendship) {
            return response()->json([
                'success' => false,
                'message' => 'Hubungan pertemanan tidak ditemukan'
            ], 404);
        }
        
        $friendship->delete();

        return response()->json([
            'success' => true,
            'message' => 'Berhasil menghapus teman'
        ]);
    }
}