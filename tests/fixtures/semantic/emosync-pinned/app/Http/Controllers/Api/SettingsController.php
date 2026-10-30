<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\Request;

class SettingsController extends Controller
{
    /**
     * Get all user settings
     * 
     * GET /api/settings
     */
    public function index(Request $request)
    {
        $settings = $request->user()->getSettings();
        
        return response()->json([
            'success' => true,
            'privacy' => [
                'show_mood' => $settings->privacy_show_mood,
                'allow_requests' => $settings->privacy_allow_requests,
                'show_active' => $settings->privacy_show_active,
            ],
        ]);
    }



    /**
     * Update privacy settings
     * 
     * PUT /api/settings/privacy
     */
    public function updatePrivacy(Request $request)
    {
        $request->validate([
            'show_mood' => 'sometimes|boolean',
            'allow_requests' => 'sometimes|boolean',
            'show_active' => 'sometimes|boolean',
        ]);

        $settings = $request->user()->getSettings();
        
        if ($request->has('show_mood')) {
            $settings->privacy_show_mood = $request->show_mood;
        }
        if ($request->has('allow_requests')) {
            $settings->privacy_allow_requests = $request->allow_requests;
        }
        if ($request->has('show_active')) {
            $settings->privacy_show_active = $request->show_active;
        }
        
        $settings->save();
        
        return response()->json([
            'success' => true,
            'message' => 'Privacy settings updated successfully',
            'data' => [
                'show_mood' => $settings->privacy_show_mood,
                'allow_requests' => $settings->privacy_allow_requests,
                'show_active' => $settings->privacy_show_active,
            ]
        ]);
    }
}