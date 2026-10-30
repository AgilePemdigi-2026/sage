<?php

use App\Http\Controllers\Admin\AuthController as AdminAuthController;
use App\Http\Controllers\Admin\ContentController as AdminContentController;
use App\Http\Controllers\Admin\DashboardController as AdminDashboardController;
use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\ChatController;
use App\Http\Controllers\Api\ContentController;
use App\Http\Controllers\Api\FriendshipController;
use App\Http\Controllers\Api\MoodCheckinController;
use App\Http\Controllers\Api\PaymentController;
use App\Http\Controllers\Api\PemicuController;
use App\Http\Controllers\Api\PremiumController;
use App\Http\Controllers\Api\ProfileController;
use App\Http\Controllers\Api\SettingsController;
use Illuminate\Support\Facades\Route;

// ============ PUBLIC ROUTES ============
Route::post('/register', [AuthController::class, 'register']);
Route::post('/login', [AuthController::class, 'login']);
Route::get('/pemicu', [PemicuController::class, 'index']);
Route::get('/konten', [ContentController::class, 'index']);

// ============ PROTECTED ROUTES ============
Route::middleware('auth:sanctum')->group(function () {
    
    // Auth
    Route::post('/logout', [AuthController::class, 'logout']);
    Route::get('/user', [AuthController::class, 'user']);
    
    // Profile
    Route::get('/profile', [ProfileController::class, 'show']);
    Route::put('/profile', [ProfileController::class, 'update']);
    
    // Reports
    Route::get('/reports/weekly', [\App\Http\Controllers\Api\ReportController::class, 'weekly']);
    
    // Mood Checkin
    Route::post('/checkin', [MoodCheckinController::class, 'store']);
    Route::get('/checkin', [MoodCheckinController::class, 'index']);
    Route::get('/dashboard', [MoodCheckinController::class, 'dashboard']);
    
    // Premium
    Route::get('/premium/status', [PremiumController::class, 'status']);
    Route::get('/premium/plans', [PremiumController::class, 'plans']);
    Route::post('/premium/subscribe', [PremiumController::class, 'subscribe']);
    Route::post('/premium/cancel', [PremiumController::class, 'cancel']);
    
    // Friendship
    Route::get('/friends', [FriendshipController::class, 'index']);
    Route::post('/friends/add', [FriendshipController::class, 'add']);
    Route::delete('/friends/{id}', [FriendshipController::class, 'destroy']);
    Route::get('/friends/search', [FriendshipController::class, 'search']);
    Route::get('/friends/requests', [FriendshipController::class, 'requests']);
    Route::post('/friends/accept/{id}', [FriendshipController::class, 'accept']);
    
    // Content
    Route::get('/konten/{id}', [ContentController::class, 'show']);
    
    // Settings
    Route::get('/settings', [SettingsController::class, 'index']);
    Route::put('/settings/privacy', [SettingsController::class, 'updatePrivacy']);
    
    // ============ CHAT ============
    Route::get('/chat/{friendId}', [ChatController::class, 'getMessages']);
    Route::post('/chat/send', [ChatController::class, 'sendMessage']);
    Route::get('/chat/unread/count', [ChatController::class, 'getUnreadCount']);
    Route::get('/chat/unread/list', [ChatController::class, 'getUnreadPerFriend']);
    Route::put('/chat/read/{friendId}', [ChatController::class, 'markAsRead']);
    
    // ============ PAYMENT ============
    Route::get('/payment/plans', [PaymentController::class, 'getPlans']);
    Route::post('/payment/create', [PaymentController::class, 'createTransaction']);
    Route::get('/payment/status/{transactionId}', [PaymentController::class, 'checkTransaction']);
    Route::post('/payment/simulate/{transactionId}', [PaymentController::class, 'simulatePayment']);
    Route::delete('/payment/cancel/{transactionId}', [PaymentController::class, 'cancelTransaction']);
    Route::get('/payment/history', [PaymentController::class, 'getUserTransactions']);
});

// ============ ADMIN ROUTES (public: login) ============
Route::post('/admin/login', [AdminAuthController::class, 'login']);

// ============ ADMIN ROUTES (protected: auth + admin) ============
Route::middleware(['auth:sanctum', 'admin'])->prefix('admin')->group(function () {
    Route::get('/me', [AdminAuthController::class, 'me']);
    Route::get('/dashboard', [AdminDashboardController::class, 'index']);

    Route::get('/konten', [AdminContentController::class, 'index']);
    Route::get('/konten/{id}', [AdminContentController::class, 'show']);
    Route::post('/konten', [AdminContentController::class, 'store']);
    Route::match(['put', 'post'], '/konten/{id}', [AdminContentController::class, 'update']);
    Route::delete('/konten/{id}', [AdminContentController::class, 'destroy']);
    Route::post('/konten/upload', [AdminContentController::class, 'upload']);
});