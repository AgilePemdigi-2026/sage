<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Chat;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Validator;

class ChatController extends Controller
{
    // ============ GET MESSAGES WITH A FRIEND ============
    public function getMessages($friendId)
    {
        $user = Auth::user();

        // Cek apakah friend exists
        $friend = User::find($friendId);
        if (!$friend) {
            return response()->json([
                'success' => false,
                'message' => 'Teman tidak ditemukan'
            ], 404);
        }

        if (!$user->isFriendWith($friendId)) {
            return response()->json([
                'success' => false,
                'message' => 'Anda harus berteman untuk melihat pesan'
            ], 403);
        }

        // Ambil pesan antara user dan friend
        $messages = Chat::between($user->id, $friendId)
            ->orderBy('created_at', 'asc')
            ->get();

        // Format response
        $formattedMessages = $messages->map(function($message) use ($user) {
            return [
                'id' => $message->id,
                'text' => $message->message,
                'isMe' => $message->sender_id == $user->id,
                'time' => $message->created_at->format('H:i'),
                'status' => $message->is_read ? 'read' : 'sent',
                'created_at' => $message->created_at->toISOString(),
            ];
        });

        // Tandai pesan yang diterima sebagai sudah dibaca
        Chat::where('receiver_id', $user->id)
            ->where('sender_id', $friendId)
            ->where('is_read', false)
            ->update([
                'is_read' => true,
                'read_at' => now(),
            ]);

        return response()->json([
            'success' => true,
            'data' => $formattedMessages
        ]);
    }

    // ============ SEND A MESSAGE ============
    public function sendMessage(Request $request)
    {
        $user = Auth::user();

        $validator = Validator::make($request->all(), [
            'friend_id' => 'required|exists:users,id',
            'message' => 'required|string|max:1000',
        ]);

        if ($validator->fails()) {
            return response()->json([
                'success' => false,
                'message' => 'Validasi gagal',
                'errors' => $validator->errors()
            ], 422);
        }

        // Cek apakah teman valid dan bukan diri sendiri
        $friendId = $request->friend_id;
        if ($friendId == $user->id) {
            return response()->json([
                'success' => false,
                'message' => 'Tidak bisa mengirim pesan ke diri sendiri'
            ], 400);
        }

        if (!$user->isFriendWith($friendId)) {
            return response()->json([
                'success' => false,
                'message' => 'Anda harus berteman terlebih dahulu untuk mengirim pesan'
            ], 403);
        }

        // Simpan pesan
        $chat = Chat::create([
            'sender_id' => $user->id,
            'receiver_id' => $friendId,
            'message' => $request->message,
            'is_read' => false,
        ]);

        return response()->json([
            'success' => true,
            'message' => 'Pesan terkirim',
            'data' => [
                'id' => $chat->id,
                'text' => $chat->message,
                'isMe' => true,
                'time' => $chat->created_at->format('H:i'),
                'status' => 'sent',
                'created_at' => $chat->created_at->toISOString(),
            ]
        ], 201);
    }

    // ============ GET UNREAD MESSAGES COUNT ============
    public function getUnreadCount()
    {
        $user = Auth::user();

        $count = Chat::where('receiver_id', $user->id)
            ->where('is_read', false)
            ->count();

        return response()->json([
            'success' => true,
            'data' => [
                'unread_count' => $count
            ]
        ]);
    }

    // ============ GET UNREAD MESSAGES PER FRIEND ============
    public function getUnreadPerFriend()
    {
        $user = Auth::user();

        $unread = Chat::where('receiver_id', $user->id)
            ->where('is_read', false)
            ->with('sender')
            ->get()
            ->groupBy('sender_id')
            ->map(function($messages, $senderId) {
                $sender = $messages->first()->sender;
                return [
                    'friend_id' => $senderId,
                    'friend_name' => $sender->name,
                    'friend_username' => $sender->username,
                    'friend_avatar' => $sender->avatar ?? 'male',
                    'count' => $messages->count(),
                    'last_message' => $messages->last()->message,
                    'last_time' => $messages->last()->created_at->format('H:i'),
                ];
            })
            ->values();

        return response()->json([
            'success' => true,
            'data' => $unread
        ]);
    }

    // ============ MARK MESSAGES AS READ ============
    public function markAsRead($friendId)
    {
        $user = Auth::user();

        Chat::where('receiver_id', $user->id)
            ->where('sender_id', $friendId)
            ->where('is_read', false)
            ->update([
                'is_read' => true,
                'read_at' => now(),
            ]);

        return response()->json([
            'success' => true,
            'message' => 'Pesan ditandai sebagai sudah dibaca'
        ]);
    }
}
