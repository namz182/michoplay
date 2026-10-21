package app.michoplay.desktop

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Base64
import android.graphics.drawable.Drawable

class MediaPlaybackService : Service() {
  companion object {
    const val ACTION_UPDATE = "app.michoplay.desktop.media.UPDATE"
    const val ACTION_PLAY = "app.michoplay.desktop.media.PLAY"
    const val ACTION_PAUSE = "app.michoplay.desktop.media.PAUSE"
    const val ACTION_PREVIOUS = "app.michoplay.desktop.media.PREVIOUS"
    const val ACTION_NEXT = "app.michoplay.desktop.media.NEXT"
    const val EXTRA_TITLE = "title"
    const val EXTRA_ARTIST = "artist"
    const val EXTRA_PLAYING = "isPlaying"
    const val EXTRA_DURATION = "durationMs"
    const val EXTRA_POSITION = "positionMs"
    const val EXTRA_ARTWORK = "artworkDataUrl"
    private const val CHANNEL_ID = "michoplay-playback"
    private const val NOTIFICATION_ID = 9042
  }

  private var session: MediaSession? = null
  private var title = "MichoPlay"
  private var artist = "Local music"
  private var isPlaying = false
  private var durationMs = 0L
  private var positionMs = 0L
  private var artworkDataUrl: String? = null
  private var artwork: Bitmap? = null
  private val appLogo: Bitmap? by lazy { loadAppLogo() }

  override fun onCreate() {
    super.onCreate()
    session = MediaSession(this, "MichoPlay").apply {
      setCallback(object : MediaSession.Callback() {
        override fun onPlay() = dispatch(ACTION_PLAY)
        override fun onPause() = dispatch(ACTION_PAUSE)
        override fun onSkipToPrevious() = dispatch(ACTION_PREVIOUS)
        override fun onSkipToNext() = dispatch(ACTION_NEXT)
        override fun onSeekTo(pos: Long) {
          positionMs = pos
          MediaPlugin.dispatch("seek:$pos")
          refreshNotification()
        }
      })
      isActive = true
    }
    createChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action != ACTION_UPDATE) {
      intent?.action?.let(::dispatch)
      return START_STICKY
    }
    title = intent.getStringExtra(EXTRA_TITLE).orEmpty().ifBlank { "MichoPlay" }
    artist = intent.getStringExtra(EXTRA_ARTIST).orEmpty()
    isPlaying = intent.getBooleanExtra(EXTRA_PLAYING, false)
    durationMs = intent.getLongExtra(EXTRA_DURATION, 0)
    positionMs = intent.getLongExtra(EXTRA_POSITION, 0)
    val nextArtwork = intent.getStringExtra(EXTRA_ARTWORK)
    if (nextArtwork != artworkDataUrl) {
      artworkDataUrl = nextArtwork
      artwork = decodeArtwork(nextArtwork)
    }
    updateSession()
    startForeground(NOTIFICATION_ID, buildNotification())
    return START_STICKY
  }

  private fun dispatch(action: String) {
    try {
      getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:MediaAction")
        .acquire(5_000)
    } catch (_: Exception) {
      // Android will still deliver the queued action; the timeout is best effort.
    }
    when (action) {
      ACTION_PLAY -> MediaPlugin.dispatch("play")
      ACTION_PAUSE -> MediaPlugin.dispatch("pause")
      ACTION_PREVIOUS -> MediaPlugin.dispatch("previous")
      ACTION_NEXT -> MediaPlugin.dispatch("next")
    }
  }

  private fun updateSession() {
    session?.setMetadata(MediaMetadata.Builder()
      .putString(MediaMetadata.METADATA_KEY_TITLE, title)
      .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
      .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs)
      .also { builder ->
        artwork?.let {
          builder.putBitmap(MediaMetadata.METADATA_KEY_ART, it)
          builder.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, it)
        }
        appLogo?.let { builder.putBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON, it) }
      }
      .build())
    val actions = PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
      PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SKIP_TO_PREVIOUS or
      PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SEEK_TO
    session?.setPlaybackState(PlaybackState.Builder()
      .setActions(actions)
      .setState(if (isPlaying) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED, positionMs, 1f)
      .build())
  }

  private fun buildNotification(): Notification {
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
      Notification.Builder(this, CHANNEL_ID) else Notification.Builder(this)
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = launchIntent?.let {
      PendingIntent.getActivity(this, 10, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    builder.setSmallIcon(R.drawable.ic_stat_michoplay)
      .setContentTitle(title)
      .setContentText(artist)
      .setSubText("MichoPlay")
      .setCategory(Notification.CATEGORY_TRANSPORT)
      .setContentIntent(contentIntent)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setOngoing(isPlaying)
      .setShowWhen(false)
    builder.setLargeIcon(artwork ?: appLogo)
    builder
      .addAction(action(android.R.drawable.ic_media_previous, "Previous", ACTION_PREVIOUS))
      .addAction(action(if (isPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
        if (isPlaying) "Pause" else "Play", if (isPlaying) ACTION_PAUSE else ACTION_PLAY))
      .addAction(action(android.R.drawable.ic_media_next, "Next", ACTION_NEXT))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
      builder.setStyle(Notification.MediaStyle().setMediaSession(session?.sessionToken)
        .setShowActionsInCompactView(0, 1, 2))
    }
    return builder.build()
  }

  private fun decodeArtwork(dataUrl: String?): Bitmap? {
    if (dataUrl.isNullOrBlank()) return null
    return try {
      val encoded = dataUrl.substringAfter(',', dataUrl)
      val bytes = Base64.decode(encoded, Base64.DEFAULT)
      BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let { decoded ->
        val maxDimension = maxOf(decoded.width, decoded.height)
        if (maxDimension <= 512) decoded else {
          val scale = 512f / maxDimension
          Bitmap.createScaledBitmap(decoded, (decoded.width * scale).toInt().coerceAtLeast(1),
            (decoded.height * scale).toInt().coerceAtLeast(1), true).also { scaled ->
              if (scaled !== decoded) decoded.recycle()
            }
        }
      }
    } catch (_: Exception) { null }
  }

  private fun loadAppLogo(): Bitmap? {
    return try {
      val icon: Drawable = packageManager.getApplicationIcon(packageName)
      val bitmap = Bitmap.createBitmap(128, 128, Bitmap.Config.ARGB_8888)
      val canvas = Canvas(bitmap)
      icon.setBounds(0, 0, canvas.width, canvas.height)
      icon.draw(canvas)
      bitmap
    } catch (_: Exception) { null }
  }

  private fun action(icon: Int, label: String, action: String): Notification.Action {
    val intent = Intent(this, MediaPlaybackService::class.java).setAction(action)
    val pending = PendingIntent.getService(this, action.hashCode(), intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
      Notification.Action.Builder(icon, label, pending).build()
    else @Suppress("DEPRECATION") Notification.Action(icon, label, pending)
  }

  private fun refreshNotification() {
    updateSession()
    val manager = getSystemService(NotificationManager::class.java)
    manager.notify(NOTIFICATION_ID, buildNotification())
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(CHANNEL_ID, "Music playback", NotificationManager.IMPORTANCE_LOW)
      getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }
  }

  override fun onDestroy() {
    session?.isActive = false
    session?.release()
    session = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
