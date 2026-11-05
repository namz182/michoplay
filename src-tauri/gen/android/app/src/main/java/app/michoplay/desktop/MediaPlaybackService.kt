package app.michoplay.desktop

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat

class MediaPlaybackService : Service() {
  companion object {
    const val ACTION_REQUEST_FOCUS = "app.michoplay.desktop.media.REQUEST_FOCUS"
    const val ACTION_PLAY = "app.michoplay.desktop.media.PLAY"
    const val ACTION_PAUSE = "app.michoplay.desktop.media.PAUSE"
    const val ACTION_PREVIOUS = "app.michoplay.desktop.media.PREVIOUS"
    const val ACTION_NEXT = "app.michoplay.desktop.media.NEXT"
    const val ACTION_FAVORITE = "app.michoplay.desktop.media.FAVORITE"
    private const val CHANNEL_ID = "michoplay-playback"
    private const val NOTIFICATION_ID = 9042
    private const val TAG = "MichoPlayMedia"
    // Accessed on the main thread, including plugin commands.
    private var running: MediaPlaybackService? = null
    private val pendingFocusRequests = mutableListOf<(Boolean, Long) -> Unit>()
    private var nextFocusGeneration = 0L

    fun requestFocus(context: Context, result: (Boolean, Long) -> Unit) {
      running?.let { result(it.acquireAudioFocus(), it.focusGeneration); return }
      pendingFocusRequests.add(result)
      try {
        ContextCompat.startForegroundService(context,
          Intent(context, MediaPlaybackService::class.java).setAction(ACTION_REQUEST_FOCUS))
      } catch (error: Exception) {
        pendingFocusRequests.remove(result)
        throw error
      }
    }

    fun publish(args: MediaUpdateArgs) {
      running?.let { it.applyUpdate(args); return }
      // Focus acquisition creates the service before the engine starts. If it
      // vanished, pause the engine instead of rebuilding a stale playing session.
      if (args.isPlaying) MediaPlugin.dispatch("service-stopped:${args.focusGeneration}")
    }

    fun stopFromPlayer(context: Context) {
      running?.stoppingFromPlayer = true
      context.stopService(Intent(context, MediaPlaybackService::class.java))
    }
  }

  private var session: MediaSession? = null
  private var title = "MichoPlay"
  private var artist = ""
  private var isPlaying = false
  private var durationMs = 0L
  private var positionMs = 0L
  private var positionUpdatedAt = 0L
  private var artworkPath: String? = null
  private var artwork: Bitmap? = null
  private var trackId = -1L
  private var isFavorite = false
  private val defaultArtwork by lazy { createDefaultArtwork() }
  private lateinit var audioManager: AudioManager
  private var focusRequest: AudioFocusRequest? = null
  private var focusGeneration = 0L
  private lateinit var playbackWakeLock: PowerManager.WakeLock
  private var hasAudioFocus = false
  private var focusRequested = false
  private var focusInterrupted = false
  private var stoppingFromPlayer = false
  private val noisyReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) {
        abandonAudioFocus()
        pauseForSystem("becoming-noisy")
      }
    }
  }

  override fun onCreate() {
    super.onCreate()
    running = this
    audioManager = getSystemService(AudioManager::class.java)
    playbackWakeLock = getSystemService(PowerManager::class.java)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:Playback").apply {
        setReferenceCounted(false)
      }
    ContextCompat.registerReceiver(this, noisyReceiver,
      IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), ContextCompat.RECEIVER_NOT_EXPORTED)
    session = MediaSession(this, "MichoPlay").apply {
      setCallback(object : MediaSession.Callback() {
        override fun onPlay() = dispatch(ACTION_PLAY)
        override fun onPause() = dispatch(ACTION_PAUSE)
        override fun onSkipToPrevious() = dispatch(ACTION_PREVIOUS)
        override fun onSkipToNext() = dispatch(ACTION_NEXT)
        override fun onCustomAction(action: String, extras: Bundle?) {
          if (action == ACTION_FAVORITE) dispatchFavorite()
        }
        override fun onSeekTo(pos: Long) {
          wakeForEngineAction()
          MediaPlugin.dispatch("seek:${pos.coerceAtLeast(0)}")
        }
      })
      isActive = true
    }
    createChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_REQUEST_FOCUS -> {
        // Android 15+ requires an active foreground service before a background
        // media-button action can acquire focus. Resolve only after focus is granted.
        startForeground(NOTIFICATION_ID, buildNotification())
        val granted = try { acquireAudioFocus() } catch (error: Exception) {
          Log.e(TAG, "Audio focus request failed", error)
          false
        }
        val callbacks = pendingFocusRequests.toList()
        pendingFocusRequests.clear()
        callbacks.forEach { it(granted, focusGeneration) }
      }
      null -> stopSelf()
      else -> intent.action?.let(::dispatch)
    }
    // Never restart a stale "playing" notification after the audio process dies.
    return START_NOT_STICKY
  }

  private fun acquireAudioFocus(): Boolean {
    if (hasAudioFocus) return true
    abandonAudioFocus()
    focusGeneration = ++nextFocusGeneration
    val generation = focusGeneration
    focusRequested = true
    val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
      .setAudioAttributes(AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
      .setWillPauseWhenDucked(false)
      .setOnAudioFocusChangeListener({ change -> handleFocusChange(generation, change) }, Handler(Looper.getMainLooper()))
      .build()
    focusRequest = request
    hasAudioFocus = audioManager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    if (!hasAudioFocus) abandonAudioFocus()
    return hasAudioFocus
  }

  private fun handleFocusChange(generation: Long, change: Int) {
    if (!focusRequested || generation != focusGeneration) return
    when (change) {
      AudioManager.AUDIOFOCUS_GAIN -> {
        hasAudioFocus = true
        focusInterrupted = false
        wakeForEngineAction()
        MediaPlugin.dispatch("focus-gain:$generation")
      }
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
        hasAudioFocus = false
        focusInterrupted = true
        pauseForSystem("focus-loss-transient")
      }
      // Android lowers and restores music volume for short notification sounds.
      // Keep playback and the media session active if this callback is delivered.
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> Unit
      AudioManager.AUDIOFOCUS_LOSS -> {
        abandonAudioFocus()
        pauseForSystem("focus-loss")
      }
    }
  }

  private fun abandonAudioFocus() {
    val request = focusRequest
    focusRequest = null
    focusRequested = false
    hasAudioFocus = false
    focusInterrupted = false
    if (request != null) audioManager.abandonAudioFocusRequest(request)
  }

  private fun applyUpdate(args: MediaUpdateArgs) {
    if (args.focusGeneration != focusGeneration) return
    title = args.title.ifBlank { "MichoPlay" }
    artist = args.artist
    trackId = args.trackId
    isFavorite = args.isFavorite
    durationMs = args.durationMs.coerceAtLeast(0)
    positionMs = args.positionMs.coerceAtLeast(0)
    positionUpdatedAt = SystemClock.elapsedRealtime()
    // A late snapshot must never regain focus or overwrite a system interruption.
    isPlaying = args.isPlaying && hasAudioFocus
    if (args.isPlaying && !hasAudioFocus) {
      MediaPlugin.dispatch("${if (focusInterrupted) "focus-loss-transient" else "focus-loss"}:$focusGeneration")
    }
    if (!args.isPlaying && !args.interrupted) abandonAudioFocus()
    if (args.artworkPath != artworkPath || artwork == null) {
      artworkPath = args.artworkPath
      artwork = decodeArtwork(artworkPath)
    }
    syncWakeLock()
    updateSession()
    startForeground(NOTIFICATION_ID, buildNotification())
  }

  private fun pauseForSystem(action: String) {
    wakeForEngineAction()
    if (isPlaying) {
      positionMs += (SystemClock.elapsedRealtime() - positionUpdatedAt).coerceAtLeast(0)
      if (durationMs > 0) positionMs = positionMs.coerceAtMost(durationMs)
    }
    isPlaying = false
    MediaPlugin.dispatch(if (action == "pause") action else "$action:$focusGeneration")
    syncWakeLock()
    refreshNotification()
  }

  private fun syncWakeLock() {
    if (isPlaying && !playbackWakeLock.isHeld) playbackWakeLock.acquire()
    else if (!isPlaying && playbackWakeLock.isHeld) playbackWakeLock.release()
  }

  private fun wakeForEngineAction() {
    // Keep the native engine's action loop awake until it can acknowledge the command.
    getSystemService(PowerManager::class.java)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:MediaAction").acquire(5_000)
  }

  private fun dispatch(action: String) {
    when (action) {
      ACTION_PLAY -> { wakeForEngineAction(); MediaPlugin.dispatch("play") }
      ACTION_PAUSE -> {
        wakeForEngineAction()
        abandonAudioFocus()
        pauseForSystem("pause")
      }
      ACTION_PREVIOUS -> { wakeForEngineAction(); MediaPlugin.dispatch("previous") }
      ACTION_NEXT -> { wakeForEngineAction(); MediaPlugin.dispatch("next") }
      ACTION_FAVORITE -> dispatchFavorite()
    }
  }

  private fun dispatchFavorite() {
    if (trackId < 0) return
    wakeForEngineAction()
    MediaPlugin.dispatch("favorite:$focusGeneration:$trackId")
  }

  private fun updateSession() {
    val cover = artwork ?: defaultArtwork
    session?.setMetadata(MediaMetadata.Builder()
      .putString(MediaMetadata.METADATA_KEY_TITLE, title)
      .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
      .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs)
      .putBitmap(MediaMetadata.METADATA_KEY_ART, cover)
      .putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, cover)
      .putBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON, cover)
      .build())
    val actions = PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
      PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SKIP_TO_PREVIOUS or
      PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SEEK_TO
    val state = PlaybackState.Builder().setActions(actions)
    if (trackId >= 0) state.addCustomAction(ACTION_FAVORITE,
        if (isFavorite) "Remove from favorites" else "Add to favorites",
        if (isFavorite) R.drawable.ic_favorite_filled else R.drawable.ic_favorite_outline)
    session?.setPlaybackState(state.setState(
      if (isPlaying) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
      positionMs, if (isPlaying) 1f else 0f, SystemClock.elapsedRealtime()).build())
  }

  private fun buildNotification(): Notification {
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = launchIntent?.let {
      PendingIntent.getActivity(this, 10, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    val notification = Notification.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_michoplay)
      .setContentTitle(title).setContentText(artist).setSubText("MichoPlay")
      .setCategory(Notification.CATEGORY_TRANSPORT).setContentIntent(contentIntent)
      .setVisibility(Notification.VISIBILITY_PUBLIC).setOngoing(isPlaying).setShowWhen(false)
      .setLargeIcon(artwork ?: defaultArtwork)
      .addAction(action(android.R.drawable.ic_media_previous, "Previous", ACTION_PREVIOUS))
      .addAction(action(if (isPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
        if (isPlaying) "Pause" else "Play", if (isPlaying) ACTION_PAUSE else ACTION_PLAY))
      .addAction(action(android.R.drawable.ic_media_next, "Next", ACTION_NEXT))
    if (trackId >= 0) notification.addAction(action(
        if (isFavorite) R.drawable.ic_favorite_filled else R.drawable.ic_favorite_outline,
        if (isFavorite) "Remove from favorites" else "Add to favorites", ACTION_FAVORITE))
    return notification.setStyle(Notification.MediaStyle().setMediaSession(session?.sessionToken)
      .setShowActionsInCompactView(0, 1, 2)).build()
  }

  private fun decodeArtwork(path: String?): Bitmap? {
    if (path.isNullOrBlank()) return null
    return try {
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(path, bounds)
      check(bounds.outWidth > 0 && bounds.outHeight > 0) { "Artwork could not be decoded: $path" }
      val options = BitmapFactory.Options().apply {
        inSampleSize = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / inSampleSize > 1024) inSampleSize *= 2
      }
      val decoded = BitmapFactory.decodeFile(path, options) ?: return null
      val maxDimension = maxOf(decoded.width, decoded.height)
      if (maxDimension <= 512) decoded else {
        val scale = 512f / maxDimension
        Bitmap.createScaledBitmap(decoded, (decoded.width * scale).toInt().coerceAtLeast(1),
          (decoded.height * scale).toInt().coerceAtLeast(1), true).also { decoded.recycle() }
      }
    } catch (error: Exception) {
      Log.w(TAG, "Notification artwork failed", error)
      null
    }
  }

  private fun createDefaultArtwork(): Bitmap {
    val bitmap = Bitmap.createBitmap(256, 256, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    canvas.drawColor(Color.rgb(40, 40, 43))
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.rgb(165, 162, 173)
      style = Paint.Style.STROKE
      strokeWidth = 5f
    }
    canvas.drawCircle(128f, 128f, 43f, paint)
    canvas.drawCircle(128f, 128f, 25f, paint)
    canvas.drawCircle(128f, 128f, 6f, paint)
    return bitmap
  }

  private fun action(icon: Int, label: String, action: String): Notification.Action {
    val intent = Intent(this, MediaPlaybackService::class.java).setAction(action)
    val pending = PendingIntent.getService(this, action.hashCode(), intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    return Notification.Action.Builder(icon, label, pending).build()
  }

  private fun refreshNotification() {
    updateSession()
    getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification())
  }

  private fun createChannel() {
    val channel = NotificationChannel(CHANNEL_ID, "Music playback", NotificationManager.IMPORTANCE_LOW)
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  override fun onDestroy() {
    running = null
    if (!stoppingFromPlayer) MediaPlugin.dispatch("service-stopped:$focusGeneration")
    pendingFocusRequests.toList().also { pendingFocusRequests.clear() }.forEach { it(false, focusGeneration) }
    unregisterReceiver(noisyReceiver)
    abandonAudioFocus()
    isPlaying = false
    syncWakeLock()
    session?.isActive = false
    session?.release()
    session = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
