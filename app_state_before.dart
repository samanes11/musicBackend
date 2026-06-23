import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:flutter/foundation.dart';
import 'package:just_audio/just_audio.dart';
import 'package:music_player/services/session_cache.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../core/app_exceptions.dart';
import '../core/error_handler.dart';
import 'api_service.dart';
import 'local_audio_cache.dart';
import 'song_metadata_store.dart';
import 'package:music_player/widget/artwork_widget.dart';
import 'package:audio_service/audio_service.dart';
import 'audio_handler.dart';

// DEFAULT_COVER_URL
const String _defaultCoverUrl =
    'https://cdn.qepal.com/qeupload/6759d578be4c8e9471a45c81/download22jpg-ghyhvjsfacjurgu04sjd2zog0rzk1e.jpg';

//  Download state model
enum DownloadStatus { idle, waiting, downloading, completed, failed, cancelled }

class DownloadState {
  final String songId;
  final DownloadStatus status;
  final int progress;
  final int downloadedBytes;
  final int totalBytes;
  final String? error;

  /// True when [error] came from a retryable failure (network/timeout/server),
  /// so the UI can offer a "Retry" affordance instead of treating it as final.
  final bool errorRetryable;

  const DownloadState({
    required this.songId,
    this.status = DownloadStatus.idle,
    this.progress = 0,
    this.downloadedBytes = 0,
    this.totalBytes = 0,
    this.error,
    this.errorRetryable = false,
  });

  DownloadState copyWith({
    DownloadStatus? status,
    int? progress,
    int? downloadedBytes,
    int? totalBytes,
    String? error,
    bool? errorRetryable,
  }) =>
      DownloadState(
        songId: songId,
        status: status ?? this.status,
        progress: progress ?? this.progress,
        downloadedBytes: downloadedBytes ?? this.downloadedBytes,
        totalBytes: totalBytes ?? this.totalBytes,
        error: error ?? this.error,
        errorRetryable: errorRetryable ?? this.errorRetryable,
      );

  String get sizeLabel {
    if (totalBytes <= 0) return '';
    return '${_fmtBytes(downloadedBytes)} / ${_fmtBytes(totalBytes)}';
  }

  static String _fmtBytes(int b) {
    if (b <= 0) return '0 B';
    if (b < 1024) return '$b B';
    if (b < 1024 * 1024) return '${(b / 1024).toStringAsFixed(1)} KB';
    return '${(b / (1024 * 1024)).toStringAsFixed(1)} MB';
  }
}

// ─────────────────────────────────────────────────────────────
//  Enums
// ─────────────────────────────────────────────────────────────

enum RepeatMode { off, all, one }

// ─────────────────────────────────────────────────────────────
//  Data models
// ─────────────────────────────────────────────────────────────

class Song {
  final String id;
  final String channelDbId;
  final String channelUsername;
  final String channelName;
  final String title;
  final String artist;
  final int duration;
  final String fileId;
  final int fileSize;
  String? thumbnail;
  final int messageId;
  bool isFavorite;

  Song({
    required this.id,
    required this.channelDbId,
    required this.channelUsername,
    required this.channelName,
    required this.title,
    required this.artist,
    required this.duration,
    required this.fileId,
    required this.fileSize,
    this.thumbnail,
    required this.messageId,
    this.isFavorite = false,
  });

  factory Song.fromJson(Map<String, dynamic> json) => Song(
        id: _str(json['_id']),
        channelDbId: _str(json['channelDbId']),
        channelUsername: _str(json['channelUsername']),
        channelName: _str(json['channelName']),
        title: _str(json['title'], fallback: 'Unknown'),
        artist: _str(json['artist'], fallback: 'Unknown'),
        duration: _int(json['duration']),
        fileId: _str(json['fileId']),
        fileSize: _int(json['fileSize']),
        thumbnail: json['thumbnail']?.toString(),
        messageId: _int(json['messageId']),
        isFavorite: json['isFavorite'] == true,
      );

  String get durationStr {
    final m = duration ~/ 60;
    final s = duration % 60;
    return '$m:${s.toString().padLeft(2, '0')}';
  }
}

String _str(dynamic v, {String fallback = ''}) {
  if (v == null) return fallback;
  if (v is String) return v;
  if (v is Map && v[r'$oid'] != null) return v[r'$oid'].toString();
  return v.toString();
}

int _int(dynamic v, {int fallback = 0}) {
  if (v == null) return fallback;
  if (v is int) return v;
  if (v is num) return v.round();
  return int.tryParse(v.toString()) ?? fallback;
}

class Channel {
  final String channelUsername;
  final String channelName;
  final String? photoUrl;
  final String status;
  final int songsCount;

  Channel({
    required this.channelUsername,
    required this.channelName,
    this.photoUrl,
    required this.status,
    required this.songsCount,
  });

  String get id => channelUsername;

  factory Channel.fromJson(Map<String, dynamic> json) => Channel(
        channelUsername: _str(json['channelUsername']),
        channelName: _str(json['channelName']),
        photoUrl: json['photoUrl']?.toString(),
        status: _str(json['status'], fallback: 'pending'),
        songsCount: _int(json['songsCount']),
      );
}

class Playlist {
  final String id;
  final String name;
  final String? description;
  final int songsCount;

  Playlist({
    required this.id,
    required this.name,
    this.description,
    required this.songsCount,
  });

  factory Playlist.fromJson(Map<String, dynamic> json) => Playlist(
        id: json['_id']?.toString() ?? '',
        name: json['name'] ?? '',
        description: json['description'],
        songsCount: json['songsCount'] ?? 0,
      );
}

//  AppState

class AppState extends ChangeNotifier {
  final ApiService api = ApiService();
  AudioPlayerHandler get _handler => audioHandler;
  final LocalAudioCache _cache = LocalAudioCache.instance;
  final _rng = Random();
  bool isOffline = false;

  // ── Multi-selection ───────────────────────────────────────
  bool selectionMode = false;
  final Set<String> selectedSongIds = {};

  void toggleSelectionMode() {
    selectionMode = !selectionMode;
    if (!selectionMode) selectedSongIds.clear();
    notifyListeners();
  }

  void toggleSongSelection(String songId) {
    if (selectedSongIds.contains(songId)) {
      selectedSongIds.remove(songId);
    } else {
      selectedSongIds.add(songId);
    }
    if (selectedSongIds.isEmpty) selectionMode = false;
    notifyListeners();
  }

  void selectAllSongs(List<Song> songs) {
    selectedSongIds.addAll(songs.map((s) => s.id));
    notifyListeners();
  }

  void clearSelection() {
    selectedSongIds.clear();
    selectionMode = false;
    notifyListeners();
  }

  List<Song> get selectedSongs {
    final allSongs = [...songs, ...favorites];
    return allSongs.where((s) => selectedSongIds.contains(s.id)).toList();
  }

  // Auth
  String? userId;
  String? userName;
  String? userEmail;
  DateTime? subscriptionExpiresAt;
  String? subscriptionPlan;
  bool get isPremium =>
      subscriptionExpiresAt != null &&
      subscriptionExpiresAt!.isAfter(DateTime.now());
  bool get isLoggedIn => ApiService.isLoggedIn && userId != null;

  // Data
  List<Channel> channels = [];
  List<Song> songs = [];
  List<Song> favorites = [];
  List<Playlist> playlists = [];

  // Player
  Song? currentSong;
  bool isPlaying = false;
  bool playerLoading = false;

  /// True from the moment user taps next/prev until playback actually starts.
  bool songLoading = false;
  Duration playerPosition = Duration.zero;
  Duration playerDuration = Duration.zero;

  // ── Queue & playback modes ─────────────────────────────────
  List<Song> _queue = [];
  List<Song> _shuffledQueue = [];
  int _queueIndex = -1;

  bool _shuffleOn = false;
  RepeatMode _repeatMode = RepeatMode.off;
  double _volume = 1.0;

  bool get shuffleOn => _shuffleOn;
  RepeatMode get repeatMode => _repeatMode;
  double get volume => _volume;

  bool get hasPrevious => _queueIndex > 0;
  bool get hasNext {
    final q = _activeQueue;
    return _queueIndex < q.length - 1 || _repeatMode != RepeatMode.off;
  }

  // ── Download tracking ──────────────────────────────────────
  final Map<String, DownloadState> _downloads = {};
  final Map<String, bool> _cancelFlags = {};

  // ── Download Queue ─────────────────────────────────────────
  final List<Song> _downloadQueue = [];
  bool _queueWorkerRunning = false;

  List<Song> get downloadQueue => List.unmodifiable(_downloadQueue);
  Map<String, DownloadState> get downloads => Map.unmodifiable(_downloads);

  DownloadState? downloadStateFor(String songId) => _downloads[songId];

  bool isDownloading(String songId) {
    final s = _downloads[songId]?.status;
    return s == DownloadStatus.waiting || s == DownloadStatus.downloading;
  }

  int get cachedSongsCount => _downloads.values
      .where((d) => d.status == DownloadStatus.completed)
      .length;

  // Loading flags
  bool loadingChannels = false;
  bool loadingSongs = false;
  bool _initialLoad = true;
  bool get initialLoad => _initialLoad;
  bool loadingFavorites = false;
  bool syncing = false;
  bool authLoading = false;
  bool isShowingStaleData = false;

  /// Human-readable, already-localized-ish error message — safe to show
  /// directly in the UI. Populated by [ErrorHandler.normalize].
  String? error;

  /// True when the last [error] came from a retryable condition
  /// (no connection / timeout / 5xx), so UI can show a "Retry" button.
  bool errorRetryable = false;

  void _setError(Object e, {String? context}) {
    final err = ErrorHandler.normalize(e);
    error = err.message;
    errorRetryable = err.retryable;
    ErrorHandler.log(err, context: context);
  }

  void clearError() {
    error = null;
    errorRetryable = false;
  }

  bool _pendingSubscriptionPrompt = false;
  bool get pendingSubscriptionPrompt => _pendingSubscriptionPrompt;
  void clearSubscriptionPrompt() => _pendingSubscriptionPrompt = false;

  // Pagination
  int _songsPage = 1;
  bool hasMoreSongs = true;
  String? _currentChannelFilter;

  // ── Constructor ───────────────────────────────────────────────

  Duration _lastNotifiedPosition = Duration.zero;
  String? _predownloadedForSongId;

  AppState() {
    _handler.playerStateStream.listen((state) {
      isPlaying = state.playing;
      playerLoading = state.processingState == ProcessingState.loading ||
          state.processingState == ProcessingState.buffering;

      if (state.processingState == ProcessingState.completed) {
        isPlaying = false;
        playerPosition = playerDuration;
        notifyListeners();
        _onTrackCompleted();
        return;
      }
      notifyListeners();
    });

    _handler.positionStream.listen((pos) {
      playerPosition = pos;
      final diff = (pos - _lastNotifiedPosition).abs();
      if (diff >= const Duration(milliseconds: 500)) {
        _lastNotifiedPosition = pos;
        notifyListeners();
      }
      _maybePredownloadNext(pos);
    });

    _handler.durationStream.listen((dur) {
      if (dur == null) return;
      playerDuration = dur;
      notifyListeners();
    });

    _handler.onSkipToNext.listen((_) async {
      if (songLoading) return;
      final next = await _nextCachedSong();
      if (next == null) return;
      _queueIndex = _activeQueue.indexWhere((s) => s.id == next.id);
      await playSong(next);
    });

    _handler.onSkipToPrevious.listen((_) async {
      if (songLoading) return;
      if (playerPosition.inSeconds > 3) {
        await seekTo(Duration.zero);
        return;
      }
      final prev = await _previousCachedSong();
      if (prev == null) return;
      _queueIndex = _activeQueue.indexWhere((s) => s.id == prev.id);
      await playSong(prev);
    });
  }

  // Subscibetion _________________________________________________

  void _applySubscriptionFromUser(Map<String, dynamic> user) {
    subscriptionPlan = user['subscriptionPlan']?.toString();
    final raw = user['subscriptionExpiresAt'];
    subscriptionExpiresAt =
        raw != null ? DateTime.tryParse(raw.toString()) : null;
  }

  Future<bool> refreshSubscriptionStatus() async {
    try {
      final res = await api.getSubscriptionStatus();
      subscriptionPlan = res['subscriptionPlan']?.toString();
      final raw = res['subscriptionExpiresAt'];
      subscriptionExpiresAt =
          raw != null ? DateTime.tryParse(raw.toString()) : null;
      await _persistUserInfo();
      notifyListeners();
      return isPremium;
    } catch (e) {
      ErrorHandler.log(e, context: 'refreshSubscriptionStatus');
      return isPremium;
    }
  }

  Future<Map<String, dynamic>> createSubscriptionOrder(String planId) =>
      api.createSubscriptionOrder(planId);

  Future<String> checkSubscriptionOrderStatus(String orderId) async {
    final res = await api.getSubscriptionOrderStatus(orderId);
    return res['status']?.toString() ?? 'pending';
  }

  Future<List<Map<String, dynamic>>> fetchSubscriptionPlans() =>
      api.getSubscriptionPlans();

  // ── Offline support helpers ────────────────────────────────────

  static const _userInfoKey = 'persisted_user_info';
  static const _favIdsKey = 'persisted_favorite_ids';
  static const _pinnedChannelsKey = 'pinned_channel_ids';

  Set<String> _pinnedChannelIds = {};
  Set<String> get pinnedChannelIds => _pinnedChannelIds;

  bool isChannelPinned(String channelId) =>
      _pinnedChannelIds.contains(channelId);

  void togglePinChannel(String channelId) {
    if (_pinnedChannelIds.contains(channelId)) {
      _pinnedChannelIds.remove(channelId);
    } else {
      _pinnedChannelIds.add(channelId);
    }
    notifyListeners();
    unawaited(_persistPinnedChannels());
  }

  Future<void> _persistPinnedChannels() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setStringList(_pinnedChannelsKey, _pinnedChannelIds.toList());
    } catch (e) {
      ErrorHandler.log(e, context: '_persistPinnedChannels');
    }
  }

  Future<void> _loadPinnedChannels() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      _pinnedChannelIds =
          (prefs.getStringList(_pinnedChannelsKey) ?? []).toSet();
    } catch (e) {
      ErrorHandler.log(e, context: '_loadPinnedChannels');
    }
  }

  List<Channel> get sortedChannels {
    final pinned =
        channels.where((c) => _pinnedChannelIds.contains(c.id)).toList();
    final rest =
        channels.where((c) => !_pinnedChannelIds.contains(c.id)).toList();
    return [...pinned, ...rest];
  }

  Future<void> _persistUserInfo() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
        _userInfoKey,
        jsonEncode({
          'id': userId,
          'name': userName,
          'email': userEmail,
          'subscriptionPlan': subscriptionPlan,
          'subscriptionExpiresAt': subscriptionExpiresAt?.toIso8601String(),
        }),
      );
    } catch (e) {
      ErrorHandler.log(e, context: '_persistUserInfo');
    }
  }

  Future<void> _loadPersistedUserInfo() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_userInfoKey);
      if (raw == null) return;
      final map = jsonDecode(raw) as Map<String, dynamic>;
      userId = map['id'] as String?;
      userName = map['name'] as String?;
      userEmail = map['email'] as String?;
      subscriptionPlan = map['subscriptionPlan'] as String?;
      final raw2 = map['subscriptionExpiresAt'];
      subscriptionExpiresAt =
          raw2 != null ? DateTime.tryParse(raw2.toString()) : null;
    } catch (e) {
      ErrorHandler.log(e, context: '_loadPersistedUserInfo');
    }
  }

  Future<void> _persistFavoriteIds() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setStringList(
        _favIdsKey,
        favorites.map((f) => f.id).toList(),
      );
    } catch (e) {
      ErrorHandler.log(e, context: '_persistFavoriteIds');
    }
  }

  Future<Set<String>> _loadPersistedFavoriteIds() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return (prefs.getStringList(_favIdsKey) ?? []).toSet();
    } catch (e) {
      ErrorHandler.log(e, context: '_loadPersistedFavoriteIds');
      return {};
    }
  }

  /// Tries to restore a session from saved tokens. Returns true if the
  /// app can proceed (either online with a fresh session, or offline
  /// with cached local data). Returns false only when the session is
  /// genuinely invalid (token rejected by the server).
  Future<bool> tryAutoLogin() async {
    await ApiService.loadTokens();
    if (!ApiService.isLoggedIn) return false;

    await _loadPersistedUserInfo();

    // ── نمایش فوری آخرین اطلاعات ذخیره‌شده (مثل اسپاتیفای/اپل موزیک) ──
    // به‌جای اسکلتون لودینگ، همون چیزی که آخرین بار دیده شده رو نشون بده
    // و وقتی دیتای تازه اومد، بی‌صدا جاش رو عوض کن.
    await _hydrateFromCache();

    try {
      final user = await api.getMe();
      userId = user['id']?.toString() ?? user['_id']?.toString();
      userName = user['name'] ?? '';
      userEmail = user['email'] ?? '';
      _applySubscriptionFromUser(user);
      isOffline = false;
      await _persistUserInfo();
      notifyListeners();

      if (songs.isEmpty && channels.isEmpty) {
        unawaited(_loadAll());
      }
      return true;
    } catch (e) {
      final err = ErrorHandler.normalize(e);
      ErrorHandler.log(err, context: 'tryAutoLogin');

      if (err is AuthException) {
        await ApiService.clearTokens();
        return false;
      }
      return _enterOfflineMode();
    }
  }

  /// نمایش فوری آخرین snapshot ذخیره‌شده از home/channels/playlists/favorites
  /// تا کاربر بلافاصله محتوا ببینه، بدون اسکلتون خسته‌کننده.
  Future<void> _hydrateFromCache() async {
    if (songs.isNotEmpty || channels.isNotEmpty) return;
    try {
      final cachedChannels = await SessionCache.instance.loadChannels();
      final cachedSongs = await SessionCache.instance.loadSongs();
      final cachedPlaylists = await SessionCache.instance.loadPlaylists();
      final cachedFavorites = await SessionCache.instance.loadFavorites();

      if (cachedChannels.isNotEmpty) channels = cachedChannels;
      if (cachedSongs.isNotEmpty) songs = cachedSongs;
      if (cachedPlaylists.isNotEmpty) playlists = cachedPlaylists;
      if (cachedFavorites.isNotEmpty) {
        favorites = cachedFavorites;
        _markFavorites(songs);
      }

      if (channels.isNotEmpty || songs.isNotEmpty) {
        // دیتای قبلی موجوده — دیگه نیازی به اسکلتون نیست
        _initialLoad = false;
        isShowingStaleData = true;
      }
      notifyListeners();
    } catch (e) {
      ErrorHandler.log(e, context: '_hydrateFromCache');
    }
  }

  Future<bool> _enterOfflineMode() async {
    if (userId == null) return false;
    isOffline = true;
    notifyListeners();
    await _loadOfflineData();
    return true;
  }

  Future<void> _loadOfflineData() async {
    await _loadPinnedChannels();
    await SongMetadataStore.instance.load();
    songs = SongMetadataStore.instance.all.values.toList();

    final favIds = await _loadPersistedFavoriteIds();
    for (final s in songs) s.isFavorite = favIds.contains(s.id);
    favorites = songs.where((s) => s.isFavorite).toList();

    await _restoreCacheStates();

    _initialLoad = false;
    loadingChannels = false;
    loadingSongs = false;
    notifyListeners();
  }

  /// وقتی اینترنت برگشت، این رو صدا بزن (مثلاً با دکمه "تلاش دوباره")
  Future<bool> retryConnection() async {
    if (!ApiService.isLoggedIn) return false;
    try {
      final user = await api.getMe();
      userId = user['id']?.toString() ?? user['_id']?.toString();
      userName = user['name'] ?? '';
      userEmail = user['email'] ?? '';
      _applySubscriptionFromUser(user);
      isOffline = false;
      clearError();
      await _persistUserInfo();
      notifyListeners();
      await _loadAll();
      return true;
    } catch (e) {
      ErrorHandler.log(e, context: 'retryConnection');
      return false;
    }
  }

  // ── Auth ──────────────────────────────────────────────────────

  Future<void> register({
    required String email,
    required String password,
    String? name,
  }) async {
    authLoading = true;
    clearError();
    notifyListeners();
    try {
      final user = await api.register(email: email, password: password);
      userId = user['id']?.toString() ?? user['_id']?.toString();
      userName = user['name'] ?? '';
      userEmail = user['email'] ?? '';
      _applySubscriptionFromUser(user);
      isOffline = false;
      await _persistUserInfo();
      notifyListeners();
      _loadAll();
    } catch (e) {
      _setError(e, context: 'register');
      rethrow;
    } finally {
      authLoading = false;
      notifyListeners();
    }
  }

  Future<void> login({required String email, required String password}) async {
    authLoading = true;
    clearError();
    notifyListeners();
    try {
      final user = await api.login(email: email, password: password);
      userId = user['id']?.toString() ?? user['_id']?.toString();
      userName = user['name'] ?? '';
      userEmail = user['email'] ?? '';
      _applySubscriptionFromUser(user);
      notifyListeners();
      _loadAll();
    } catch (e) {
      _setError(e, context: 'login');
      rethrow;
    } finally {
      authLoading = false;
      notifyListeners();
    }
  }

  Future<void> logout() async {
    await api.logout();
    userId = null;
    userName = null;
    userEmail = null;
    subscriptionPlan = null;
    subscriptionExpiresAt = null;
    channels = [];
    songs = [];
    favorites = [];
    playlists = [];
    _downloads.clear();
    _cancelFlags.clear();
    _downloadQueue.clear();
    _queueWorkerRunning = false;
    _queue = [];
    _shuffledQueue = [];
    _queueIndex = -1;
    selectedSongIds.clear();
    selectionMode = false;
    clearError();
    await stopPlayer();
    notifyListeners();
  }

  // ── Initial Load ──────────────────────────────────────────────

  Future<void> _loadAll() async {
    await SongMetadataStore.instance.load();
    await Future.wait([
      _loadPinnedChannels(),
      loadChannels(),
      loadFavorites(),
      loadPlaylists(),
      loadSongs(refresh: true),
    ]);

    _fillChannelNames(songs);
    _markFavorites(songs);
    isShowingStaleData = false;
    notifyListeners();
  }

  Future<void> _restoreCacheStates() async {
    final dir = Directory(await _cache.getCurrentPath());
    final Set<String> cachedSafeNames = {};

    if (await dir.exists()) {
      final entities = await dir.list().toList();
      final mp3Files = entities
          .whereType<File>()
          .where((f) => f.path.endsWith('.mp3'))
          .toList();

      final sizes = await Future.wait(
        mp3Files.map((f) => f.length().catchError((_) => 0)),
      );

      for (var i = 0; i < mp3Files.length; i++) {
        if (sizes[i] > 0) {
          final name = mp3Files[i].uri.pathSegments.last;
          cachedSafeNames.add(name.substring(0, name.length - 4));
        }
      }
    }

    final Map<String, Song> allSongs = {};
    for (final s in songs) allSongs[s.id] = s;
    for (final s in favorites) allSongs[s.id] = s;
    // آهنگ‌هایی که از هر صفحه‌ای دانلود شدن و metadata‌شون persist شده
    for (final s in SongMetadataStore.instance.all.values) {
      allSongs.putIfAbsent(s.id, () => s);
    }

    // ۳. match کردن fileId با safe-name فایل روی دیسک
    for (final song in allSongs.values) {
      if (_downloads.containsKey(song.id)) continue;

      final safeName = song.fileId.replaceAll(RegExp(r'[^a-zA-Z0-9_\-]'), '_');

      final isCached = cachedSafeNames.isNotEmpty
          ? cachedSafeNames.contains(safeName)
          : await _cache.has(song.fileId);

      if (isCached) {
        _downloads[song.id] = DownloadState(
          songId: song.id,
          status: DownloadStatus.completed,
          progress: 100,
        );
      }
    }

    notifyListeners();
  }

  // ── Channels ──────────────────────────────────────────────────

  Future<void> loadChannels() async {
    if (isOffline) return;
    loadingChannels = true;
    notifyListeners();
    try {
      final data = await api.getUserChannels();
      channels = data
          .whereType<Map>()
          .map((j) => Channel.fromJson(Map<String, dynamic>.from(j)))
          .toList();
      clearError();
      unawaited(SessionCache.instance.saveChannels(channels));
    } catch (e) {
      _setError(e, context: 'loadChannels');
    }
    loadingChannels = false;
    notifyListeners();
  }

  Future<void> addChannel(String username, String name) async {
    if (!isPremium) {
      throw const AuthException('Subscription required to add channels.');
    }
    if (isOffline) {
      throw const NoConnectionException('Please check your connection');
    }
    final displayName =
        name.trim().isEmpty ? username.replaceAll('@', '') : name.trim();

    await api.addChannel(channelUsername: username, channelName: displayName);
    await loadChannels();
    if (channels.isNotEmpty) {
      final ch = channels.firstWhere(
        (c) => c.channelUsername == username.replaceAll('@', ''),
        orElse: () => channels.first,
      );
      await syncChannel(ch);
    }
  }

  Future<void> removeChannel(String channelUsername) async {
    try {
      await api.removeChannel(channelUsername);
      channels.removeWhere((c) => c.channelUsername == channelUsername);
      songs.removeWhere((s) => s.channelUsername == channelUsername);
      notifyListeners();
    } catch (e) {
      _setError(e, context: 'removeChannel');
      rethrow;
    }
  }

  Future<Map<String, dynamic>> syncChannel(Channel channel) async {
    if (isOffline) {
      return {'success': false, 'msg': 'Please check your connection'};
    }
    syncing = true;
    notifyListeners();
    try {
      final result = await api.getSongs(
        channelUsername: _currentChannelFilter,
        page: _songsPage,
      );
      await loadChannels();
      await loadSongs(refresh: true);
      return result;
    } catch (e) {
      final err = ErrorHandler.normalize(e);
      ErrorHandler.log(err, context: 'syncChannel(${channel.channelUsername})');
      return {'success': false, 'msg': err.message};
    } finally {
      syncing = false;
      notifyListeners();
    }
  }

  // ── Songs ─────────────────────────────────────────────────────

  Future<List<Song>> loadSongs({
    bool refresh = false,
    String? channelUsername,
  }) async {
    if (isOffline) return const [];
    if (refresh) {
      _songsPage = 1;
      hasMoreSongs = true;
      _currentChannelFilter = channelUsername;
      songs = [];
    }
    if (!hasMoreSongs || loadingSongs) return const [];
    loadingSongs = true;
    notifyListeners();
    try {
      final result = await api.getSongs(
        channelUsername: _currentChannelFilter,
        page: _songsPage,
      );
      final rawSongs = (result['data'] as List? ?? []);
      final newSongs = rawSongs
          .whereType<Map>()
          .map((j) => Song.fromJson(Map<String, dynamic>.from(j)))
          .toList();
      _fillChannelNames(newSongs);
      _markFavorites(newSongs);
      songs = refresh ? newSongs : [...songs, ...newSongs];
      hasMoreSongs = result['hasMore'] == true;
      _songsPage++;
      clearError();
      if (refresh) {
        unawaited(SessionCache.instance.saveSongs(songs));
      }

      await _restoreCacheStates();

      return newSongs;
    } catch (e) {
      _setError(e, context: 'loadSongs');
      return const [];
    } finally {
      loadingSongs = false;
      _initialLoad = false;
      notifyListeners();
    }
  }

  Future<void> _refreshThumbnailIfNeeded(Song song) async {
    final current = song.thumbnail;
    final needsRefresh =
        current == null || current.isEmpty || current == _defaultCoverUrl;
    if (!needsRefresh) return;

    for (var attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await Future.delayed(const Duration(seconds: 2));
      try {
        final data = await api.getSong(song.id);
        final newThumb = data['thumbnail']?.toString();
        if (newThumb != null &&
            newThumb.isNotEmpty &&
            newThumb != song.thumbnail) {
          song.thumbnail = newThumb;
          for (final s in [
            ...songs,
            ...favorites,
            ..._queue,
            ..._shuffledQueue,
            ..._downloadQueue,
            if (currentSong != null) currentSong!,
          ]) {
            if (s.id == song.id) s.thumbnail = newThumb;
          }
          invalidateArtworkCache(song.id);
          await SongMetadataStore.instance.save(song);

          if (currentSong?.id == song.id) {
            await _handler.updateArtwork(newThumb);
          }
          notifyListeners();
          return;
        }
      } catch (e) {
        ErrorHandler.log(e, context: '_refreshThumbnailIfNeeded(${song.id})');
      }
    }
  }

  void _markFavorites(List<Song> list) {
    final ids = favorites.map((f) => f.id).toSet();
    for (final s in list) s.isFavorite = ids.contains(s.id);
  }

  void _fillChannelNames(List<Song> list) {
    for (var i = 0; i < list.length; i++) {
      final s = list[i];
      if (s.channelName.isNotEmpty) continue;
      Channel? ch;
      for (final c in channels) {
        if (c.channelUsername == s.channelUsername) {
          ch = c;
          break;
        }
      }
      if (ch == null) continue;
      list[i] = Song(
        id: s.id,
        channelDbId: s.channelDbId,
        channelUsername: s.channelUsername,
        channelName: ch.channelName,
        title: s.title,
        artist: s.artist,
        duration: s.duration,
        fileId: s.fileId,
        fileSize: s.fileSize,
        thumbnail: s.thumbnail,
        messageId: s.messageId,
        isFavorite: s.isFavorite,
      );
    }
  }

  // ── Favorites ─────────────────────────────────────────────────

  Future<void> loadFavorites() async {
    if (isOffline) return;
    loadingFavorites = true;
    notifyListeners();
    try {
      final data = await api.getFavorites();
      favorites = data
          .whereType<Map>()
          .map((j) => Song.fromJson(Map<String, dynamic>.from(j)))
          .toList();
      for (final f in favorites) f.isFavorite = true;
      final ids = favorites.map((f) => f.id).toSet();
      for (final s in songs) s.isFavorite = ids.contains(s.id);
      await _persistFavoriteIds();
      unawaited(SessionCache.instance.saveFavorites(favorites));
      clearError();
    } catch (e) {
      _setError(e, context: 'loadFavorites');
    }
    loadingFavorites = false;
    notifyListeners();
  }

  Future<void> toggleFavorite(Song song) async {
    song.isFavorite = !song.isFavorite;
    if (song.isFavorite) {
      if (!favorites.any((f) => f.id == song.id)) favorites.insert(0, song);
    } else {
      favorites.removeWhere((f) => f.id == song.id);
    }
    notifyListeners();
    unawaited(_persistFavoriteIds());

    if (isOffline) return;

    try {
      await api.toggleFavorite(song.id);
    } catch (e) {
      ErrorHandler.log(e, context: 'toggleFavorite(${song.id})');
      // Rollback optimistic update on failure
      song.isFavorite = !song.isFavorite;
      if (song.isFavorite) {
        if (!favorites.any((f) => f.id == song.id)) favorites.insert(0, song);
      } else {
        favorites.removeWhere((f) => f.id == song.id);
      }
      notifyListeners();
    }
  }

  // ── Playlists ─────────────────────────────────────────────────

  Future<void> loadPlaylists() async {
    if (isOffline) return;
    try {
      final data = await api.getPlaylists();
      playlists = data.map((j) => Playlist.fromJson(j)).toList();
      unawaited(SessionCache.instance.savePlaylists(playlists));
      notifyListeners();
    } catch (e) {
      ErrorHandler.log(e, context: 'loadPlaylists');
    }
  }

  Future<void> createPlaylist(String name) async {
    try {
      await api.createPlaylist(name);
      await loadPlaylists();
    } catch (e) {
      _setError(e, context: 'createPlaylist');
      rethrow;
    }
  }

  Future<void> deletePlaylist(String id) async {
    try {
      await api.deletePlaylist(id);
      playlists.removeWhere((p) => p.id == id);
      notifyListeners();
    } catch (e) {
      _setError(e, context: 'deletePlaylist');
      rethrow;
    }
  }

  // ── Queue helpers ─────────────────────────────────────────────

  void _setQueue(List<Song> list, Song startSong) {
    _queue = List.from(list);
    _queueIndex = _queue.indexWhere((s) => s.id == startSong.id);
    if (_queueIndex < 0) {
      _queue.insert(0, startSong);
      _queueIndex = 0;
    }
    if (_shuffleOn) _buildShuffledQueue(startSong);
  }

  void _buildShuffledQueue(Song startSong) {
    final rest = List<Song>.from(_queue)
      ..removeWhere((s) => s.id == startSong.id);
    rest.shuffle(_rng);
    _shuffledQueue = [startSong, ...rest];
    _queueIndex = 0;
  }

  List<Song> get _activeQueue => _shuffleOn ? _shuffledQueue : _queue;
  List<Song> get currentQueue => List.unmodifiable(_activeQueue);
  int get currentQueueIndex => _queueIndex;

  List<Song> get effectiveQueue {
    final q = List<Song>.from(_activeQueue);
    final queueIds = q.map((s) => s.id).toSet();
    for (final entry in _downloads.entries) {
      if (entry.value.status == DownloadStatus.completed) {
        Song? song;
        for (final s in [...songs, ...favorites]) {
          if (s.id == entry.key) {
            song = s;
            break;
          }
        }
        final meta = SongMetadataStore.instance.all[entry.key];
        song ??= meta;
        if (song != null && !queueIds.contains(song.id)) {
          q.add(song);
          queueIds.add(song.id);
        }
      }
    }
    return q;
  }

  void _onTrackCompleted() {
    _onTrackCompletedAsync();
  }

  void _maybePredownloadNext(Duration pos) {
    if (currentSong == null) return;
    final totalMs = playerDuration.inMilliseconds;
    if (totalMs <= 0) return;

    final percent = pos.inMilliseconds / totalMs;
    if (percent < 0.75) return;

    if (_repeatMode == RepeatMode.one) return;

    final q = _activeQueue;
    if (q.isEmpty || _queueIndex < 0) return;

    Song? nextSong;
    final nextIdx = _queueIndex + 1;
    if (nextIdx < q.length) {
      nextSong = q[nextIdx];
    } else if (_repeatMode == RepeatMode.all && q.isNotEmpty) {
      nextSong = q[0];
    }

    if (nextSong == null) return;

    if (_predownloadedForSongId == nextSong.id) return;

    if (isDownloading(nextSong.id)) return;

    _cache.has(nextSong.fileId).then((cached) {
      if (cached) return; // قبلاً دانلود شده، کاری نکن
      if (_predownloadedForSongId == nextSong!.id) return;
      _predownloadedForSongId = nextSong.id;
      enqueueDownload(nextSong);
    });
  }

  Future<void> _onTrackCompletedAsync() async {
    final next = await _nextCachedSong();
    if (next != null) {
      _queueIndex = _activeQueue.indexWhere((s) => s.id == next.id);
      await playSong(next);
    }
  }

  Future<Song?> _nextCachedSong() async {
    final q = _activeQueue;
    if (q.isEmpty) return null;

    if (_repeatMode == RepeatMode.one) return q[_queueIndex];

    final List<Song> candidates = [];
    final nextIdx = _queueIndex + 1;

    if (nextIdx < q.length) {
      candidates.addAll(q.sublist(nextIdx));
    }
    if (_repeatMode == RepeatMode.all && nextIdx >= q.length) {
      candidates.addAll(q);
    }

    if (candidates.isEmpty) return null;

    for (final song in candidates) {
      if (await _cache.has(song.fileId)) return song;
    }

    return candidates.first;
  }

  Future<Song?> _previousCachedSong() async {
    final q = _activeQueue;
    if (q.isEmpty) return null;

    if (_repeatMode == RepeatMode.one) return q[_queueIndex];

    final List<Song> candidates = [];
    final prevIdx = _queueIndex - 1;

    if (prevIdx >= 0) {
      candidates.addAll(q.sublist(0, prevIdx + 1).reversed);
    }
    if (_repeatMode == RepeatMode.all && prevIdx < 0) {
      candidates.addAll(q.reversed);
    }

    if (candidates.isEmpty) return q[_queueIndex];

    for (final song in candidates) {
      if (await _cache.has(song.fileId)) return song;
    }

    return candidates.first;
  }

  // ── Playback modes ─────────────────────────────────────────────

  void toggleShuffle() {
    _shuffleOn = !_shuffleOn;
    if (_shuffleOn && currentSong != null) {
      _buildShuffledQueue(currentSong!);
    } else {
      if (currentSong != null) {
        _queueIndex = _queue.indexWhere((s) => s.id == currentSong!.id);
      }
    }
    notifyListeners();
  }

  void toggleRepeat() {
    _repeatMode =
        RepeatMode.values[(_repeatMode.index + 1) % RepeatMode.values.length];
    notifyListeners();
  }

  void reorderQueue(int oldIndex, int newIndex) {
    final q = _shuffleOn ? _shuffledQueue : _queue;
    if (oldIndex < 0 || oldIndex >= q.length) return;
    if (newIndex < 0 || newIndex > q.length) return;

    final adjusted = newIndex > oldIndex ? newIndex - 1 : newIndex;
    final item = q.removeAt(oldIndex);
    q.insert(adjusted, item);

    if (currentSong != null) {
      _queueIndex = q.indexWhere((s) => s.id == currentSong!.id);
    }
    notifyListeners();
  }

  Future<void> setVolume(double v) async {
    _volume = v.clamp(0.0, 1.0);
    await _handler.setVolume(_volume);
    notifyListeners();
  }

  // ── Next / Previous ───────────────────────────────────────────

  Future<void> playNext() async {
    if (songLoading) return;
    final next = await _nextCachedSong();
    if (next == null) return;
    _queueIndex = _activeQueue.indexWhere((s) => s.id == next.id);
    await playSong(next);
  }

  Future<void> playPrevious() async {
    if (songLoading) return;
    if (playerPosition.inSeconds > 3) {
      await seekTo(Duration.zero);
      return;
    }
    final prev = await _previousCachedSong();
    if (prev == null) return;
    _queueIndex = _activeQueue.indexWhere((s) => s.id == prev.id);
    await playSong(prev);
  }

  // ── Player — Local-first playback ─────────────────────────────

  Future<void> playSong(Song song, {List<Song>? queue}) async {
    if (isDownloading(song.id)) return;
    if (!isPremium) {
      final cachedFile = await _cache.get(song.fileId);
      if (cachedFile == null) {
        _pendingSubscriptionPrompt = true;
        notifyListeners();
        return;
      }
    }

    _predownloadedForSongId = null;

    if (queue != null) {
      _setQueue(queue, song);
    } else if (!_activeQueue.any((s) => s.id == song.id)) {
      _setQueue(songs, song);
    } else {
      _queueIndex = _activeQueue.indexWhere((s) => s.id == song.id);
    }

    currentSong = song;
    playerLoading = true;
    songLoading = false;
    playerPosition = Duration.zero;
    playerDuration =
        song.duration > 0 ? Duration(seconds: song.duration) : Duration.zero;
    clearError();
    notifyListeners();

    try {
      final localFile = await _cache.get(song.fileId);
      if (localFile != null) {
        await _playFromFile(localFile);
        return;
      }
      songLoading = true;
      await _handler.stop();
      isPlaying = false;
      notifyListeners();
      await _downloadAndPlay(song);
    } catch (e) {
      final err = ErrorHandler.normalize(e);
      error = 'Playback failed: ${err.message}';
      errorRetryable = err.retryable;
      ErrorHandler.log(err, context: 'playSong(${song.id})');
      playerLoading = false;
      songLoading = false;
      notifyListeners();
    }
  }

  Future<void> _playFromFile(File file) async {
    final song = currentSong!;

    try {
      await _handler.playFromFile(
        file,
        song.id,
        song.title,
        song.artist == 'Unknown' ? song.channelName : song.artist,
        song.channelName,
        song.duration,
        song.thumbnail,
      );
      await _handler.setVolume(_volume);
      songLoading = false;
      notifyListeners();
    } catch (e) {
      // Local file is likely corrupt/incomplete — drop the cache entry
      // so the user can re-download instead of getting stuck.
      final err = ErrorHandler.normalize(e);
      ErrorHandler.log(err, context: '_playFromFile(${song.id})');
      try {
        await _cache.delete(song.fileId);
      } catch (_) {}
      _downloads.remove(song.id);
      SongMetadataStore.instance.remove(song.id);
      error = 'This file seems corrupted. Please try downloading it again.';
      errorRetryable = true;
      songLoading = false;
      playerLoading = false;
      notifyListeners();
    }
  }

  Future<void> _downloadAndPlay(Song song) async {
    _cancelFlags[song.id] = false;

    _setDownload(
      song.id,
      DownloadState(songId: song.id, status: DownloadStatus.waiting),
    );

    try {
      final file = await api.downloadAudio(
        fileId: song.fileId,
        channelUsername: song.channelUsername,
        messageId: song.messageId,
        songId: song.id,
        onProgress: (downloaded, total) {
          if (_cancelFlags[song.id] == true) return;
          if (currentSong?.id != song.id) return;
          final progress = total > 0
              ? ((downloaded / total) * 100).round().clamp(0, 100)
              : 0;
          _setDownload(
            song.id,
            DownloadState(
              songId: song.id,
              status: DownloadStatus.downloading,
              progress: progress,
              downloadedBytes: downloaded,
              totalBytes: total,
            ),
          );
        },
      );

      if (_cancelFlags[song.id] == true) {
        _cancelFlags.remove(song.id);
        _setDownload(
          song.id,
          DownloadState(songId: song.id, status: DownloadStatus.cancelled),
        );
        await _cache.delete(song.fileId);
        return;
      }

      _cancelFlags.remove(song.id);
      _setDownload(
        song.id,
        DownloadState(
          songId: song.id,
          status: DownloadStatus.completed,
          progress: 100,
        ),
      );

      SongMetadataStore.instance.save(song);

      if (currentSong?.id == song.id) {
        songLoading = false;
        notifyListeners();
        await _playFromFile(file);
      } else {
        songLoading = false;
        notifyListeners();
      }
    } catch (e) {
      _cancelFlags.remove(song.id);

      final wasCancelled =
          _downloads[song.id]?.status == DownloadStatus.cancelled;
      if (!wasCancelled) {
        final err = ErrorHandler.normalize(e);
        ErrorHandler.log(err, context: '_downloadAndPlay(${song.id})');
        _setDownload(
          song.id,
          DownloadState(
            songId: song.id,
            status: DownloadStatus.failed,
            error: err.message,
            errorRetryable: err.retryable,
          ),
        );
        if (currentSong?.id == song.id) {
          error = 'Download failed: ${err.message}';
          errorRetryable = err.retryable;
          playerLoading = false;
          songLoading = false;
          notifyListeners();
        }
      } else {
        songLoading = false;
        notifyListeners();
      }
    }
  }

  void enqueueDownload(Song song) {
    if (!isPremium) return;
    final status = _downloads[song.id]?.status;
    if (status == DownloadStatus.completed ||
        status == DownloadStatus.waiting ||
        status == DownloadStatus.downloading) return;

    _setDownload(
      song.id,
      DownloadState(songId: song.id, status: DownloadStatus.waiting),
    );

    if (!_downloadQueue.any((s) => s.id == song.id)) {
      _downloadQueue.add(song);
      notifyListeners();
    }

    _startQueueWorkerIfNeeded();
  }

  void _startQueueWorkerIfNeeded() {
    if (_queueWorkerRunning) return;
    _queueWorkerRunning = true;
    _runQueueWorker();
  }

  Future<void> _runQueueWorker() async {
    while (_downloadQueue.isNotEmpty) {
      final song = _downloadQueue.first;
      final status = _downloads[song.id]?.status;

      if (status == DownloadStatus.cancelled || _cancelFlags[song.id] == true) {
        _downloadQueue.removeAt(0);
        _cancelFlags.remove(song.id);
        notifyListeners();
        continue;
      }

      await _downloadForQueue(song);

      if (_downloadQueue.isNotEmpty && _downloadQueue.first.id == song.id) {
        _downloadQueue.removeAt(0);
      }
      notifyListeners();
    }
    _queueWorkerRunning = false;
  }

  Future<void> _downloadForQueue(Song song) async {
    _cancelFlags[song.id] = false;
    _setDownload(
      song.id,
      DownloadState(songId: song.id, status: DownloadStatus.downloading),
    );

    try {
      final file = await api.downloadAudio(
        fileId: song.fileId,
        channelUsername: song.channelUsername,
        messageId: song.messageId,
        songId: song.id,
        onProgress: (downloaded, total) {
          if (_cancelFlags[song.id] == true) return;
          final progress = total > 0
              ? ((downloaded / total) * 100).round().clamp(0, 100)
              : 0;
          _setDownload(
            song.id,
            DownloadState(
              songId: song.id,
              status: DownloadStatus.downloading,
              progress: progress,
              downloadedBytes: downloaded,
              totalBytes: total,
            ),
          );
        },
      );

      if (_cancelFlags[song.id] == true) {
        _cancelFlags.remove(song.id);
        _setDownload(
          song.id,
          DownloadState(songId: song.id, status: DownloadStatus.cancelled),
        );
        await _cache.delete(song.fileId);
        return;
      }

      _cancelFlags.remove(song.id);
      _setDownload(
        song.id,
        DownloadState(
          songId: song.id,
          status: DownloadStatus.completed,
          progress: 100,
        ),
      );

      // Persist metadata so this song stays in Downloads after restart
      SongMetadataStore.instance.save(song);
      unawaited(_refreshThumbnailIfNeeded(song));

      if (currentSong?.id == song.id && !_handler.playing) {
        await _playFromFile(file);
      }
    } catch (e) {
      _cancelFlags.remove(song.id);
      final wasCancelled =
          _downloads[song.id]?.status == DownloadStatus.cancelled;
      if (!wasCancelled) {
        final err = ErrorHandler.normalize(e);
        ErrorHandler.log(err, context: '_downloadForQueue(${song.id})');
        _setDownload(
          song.id,
          DownloadState(
            songId: song.id,
            status: DownloadStatus.failed,
            error: err.message,
            errorRetryable: err.retryable,
          ),
        );
      }
    }
  }

  /// Re-enqueues a failed/cancelled download — used by "tap to retry"
  /// affordances in SongTile / DownloadQueueSheet.
  void retryDownload(Song song) {
    final status = _downloads[song.id]?.status;
    if (status != DownloadStatus.failed && status != DownloadStatus.cancelled) {
      return;
    }
    _downloads.remove(song.id);
    notifyListeners();
    enqueueDownload(song);
  }

  void cancelDownload(String songId) {
    if (!isDownloading(songId)) return;
    _cancelFlags[songId] = true;

    _setDownload(
      songId,
      DownloadState(songId: songId, status: DownloadStatus.cancelled),
    );

    if (currentSong?.id == songId) {
      currentSong = null;
      playerLoading = false;
      songLoading = false;
    }
    String? fileId;
    for (final s in [...songs, ...favorites, ..._downloadQueue]) {
      if (s.id == songId) {
        fileId = s.fileId;
        break;
      }
    }

    if (fileId == null && currentSong?.id == songId) {
      fileId = currentSong!.fileId;
    }

    if (fileId != null && fileId.isNotEmpty) {
      _cache.delete(fileId).catchError((e) {
        ErrorHandler.log(e, context: 'cancelDownload cache.delete');
        return null;
      });
    }

    _downloads.remove(songId);
    notifyListeners();
  }

  void _setDownload(String songId, DownloadState state) {
    _downloads[songId] = state;
    notifyListeners();
  }

  // ── Playback controls ─────────────────────────────────────────

  Future<void> togglePlayPause() async {
    if (currentSong == null) return;
    try {
      if (_handler.playing) {
        await _handler.pause();
      } else {
        unawaited(_handler.play());
      }
    } catch (e) {
      ErrorHandler.log(e, context: 'togglePlayPause');
    }
  }

  Future<void> seekTo(Duration position) async {
    try {
      await _handler.seekTo(position);
    } catch (e) {
      ErrorHandler.log(e, context: 'seekTo');
    }
  }

  Future<void> stopPlayer() async {
    try {
      await _handler.stop();
    } catch (e) {
      ErrorHandler.log(e, context: 'stopPlayer');
    }
    currentSong = null;
    isPlaying = false;
    playerLoading = false;
    playerPosition = Duration.zero;
    playerDuration = Duration.zero;
    notifyListeners();
  }

  // ── Local cache utilities ─────────────────────────────────────

  Future<bool> isLocalCached(Song song) => _cache.has(song.fileId);

  Future<void> deleteLocalCache(Song song) async {
    try {
      await _cache.delete(song.fileId);
      _downloads.remove(song.id);
      // Remove from persistent store so it won't reappear after restart
      SongMetadataStore.instance.remove(song.id);
      notifyListeners();
    } catch (e) {
      final err = ErrorHandler.normalize(e);
      ErrorHandler.log(err, context: 'deleteLocalCache(${song.id})');
      error = err.message;
      errorRetryable = err.retryable;
      notifyListeners();
    }
  }

  Future<String> localCacheSummary() => _cache.statsSummary();

  Future<void> clearLocalCache() async {
    try {
      await _cache.clear();
      final completedIds = _downloads.entries
          .where((e) => e.value.status == DownloadStatus.completed)
          .map((e) => e.key)
          .toList();
      _downloads.removeWhere((_, v) => v.status == DownloadStatus.completed);
      // Remove all from persistent store
      await SongMetadataStore.instance.removeAll(completedIds);
      notifyListeners();
    } catch (e) {
      final err = ErrorHandler.normalize(e);
      ErrorHandler.log(err, context: 'clearLocalCache');
      error = err.message;
      errorRetryable = err.retryable;
      notifyListeners();
    }
  }

  Future<void> addSongToPlaylist({
    required String playlistId,
    required String songId,
  }) async {
    // Prevent double-increment: only bump count if we didn't already track it
    final idx = playlists.indexWhere((p) => p.id == playlistId);
    if (idx < 0) {
      await api.addSongToPlaylist(playlistId: playlistId, songId: songId);
      return;
    }

    final pl = playlists[idx];
    // Optimistic update
    playlists[idx] = Playlist(
      id: pl.id,
      name: pl.name,
      description: pl.description,
      songsCount: pl.songsCount + 1,
    );
    notifyListeners();

    try {
      await api.addSongToPlaylist(playlistId: playlistId, songId: songId);
    } catch (e) {
      ErrorHandler.log(e, context: 'addSongToPlaylist');
      // Rollback on failure
      playlists[idx] = pl;
      notifyListeners();
      rethrow;
    }
  }

  Future<void> removeSongFromPlaylist({
    required String playlistId,
    required String songId,
  }) async {
    final idx = playlists.indexWhere((p) => p.id == playlistId);
    if (idx < 0) {
      await api.removeSongFromPlaylist(playlistId: playlistId, songId: songId);
      return;
    }

    final pl = playlists[idx];
    // Optimistic update
    playlists[idx] = Playlist(
      id: pl.id,
      name: pl.name,
      description: pl.description,
      songsCount: (pl.songsCount - 1).clamp(0, 999999),
    );
    notifyListeners();

    try {
      await api.removeSongFromPlaylist(playlistId: playlistId, songId: songId);
    } catch (e) {
      ErrorHandler.log(e, context: 'removeSongFromPlaylist');
      // Rollback on failure
      playlists[idx] = pl;
      notifyListeners();
      rethrow;
    }
  }

  Future<void> reorderPlaylist({
    required String playlistId,
    required List<String> reorderedSongIds,
  }) async {
    try {
      await api.reorderPlaylist(
        playlistId: playlistId,
        songIds: reorderedSongIds,
      );
    } catch (e) {
      ErrorHandler.log(e, context: 'reorderPlaylist');
      rethrow;
    }
  }

  @override
  void dispose() {
    super.dispose();
  }
}
