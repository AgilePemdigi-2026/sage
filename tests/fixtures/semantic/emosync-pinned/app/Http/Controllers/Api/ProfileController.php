<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Validator;

class ProfileController extends Controller
{
    // Get profile
    public function show()
    {
        $user = Auth::user();

        return response()->json([
            'success' => true,
            'data' => [
                'id' => $user->id,
                'name' => $user->name,
                'username' => $user->username,
                'email' => $user->email,
                'avatar' => $user->avatar ?? 'male',
                'is_premium' => $user->isPremium(),
                'premium_plan' => $user->premium_plan,
                'premium_expiry' => $user->premium_expiry,
                'streak' => $user->streak,
                'created_at' => $user->created_at,
            ]
        ]);
    }

    // Update profile (name and avatar)
    public function update(Request $request)
    {
        $user = Auth::user();
        
        $validator = Validator::make($request->all(), [
            'name' => 'sometimes|string|max:255',
            'avatar' => 'sometimes|in:male,female'
        ]);
        
        if ($validator->fails()) {
            return response()->json([
                'success' => false,
                'message' => 'Validasi gagal',
                'errors' => $validator->errors()
            ], 422);
        }
        
        if ($request->has('name')) {
            $user->name = $request->name;
        }
        
        if ($request->has('avatar')) {
            $user->avatar = $request->avatar;
        }
        
        $user->save();

        return response()->json([
            'success' => true,
            'message' => 'Profil berhasil diperbarui',
            'data' => [
                'id' => $user->id,
                'name' => $user->name,
                'username' => $user->username,
                'email' => $user->email,
                'avatar' => $user->avatar,
                'is_premium' => $user->isPremium(),
                'streak' => $user->streak,
            ]
        ]);
    }

}