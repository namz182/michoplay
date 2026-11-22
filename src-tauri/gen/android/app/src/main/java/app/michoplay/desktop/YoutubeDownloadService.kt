package app.michoplay.desktop

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

class YoutubeDownloadService : Service() {
  private var downloadWakeLock: PowerManager.WakeLock? = null

  companion object {
    private const val CHANNEL_ID = "michoplay-downloads"
    private const val NOTIFICATION_ID = 9043
    @Volatile private var running = false
    @Volatile private var title = "MichoPlay downloads"
    @Volatile private var detail = "Preparing audio…"
    @Volatile private var percent: Int? = null

    fun isRunning() = running

    fun update(context: android.content.Context, jobs: List<Map<String, Any?>>) {
      val active = jobs.filter { it["status"] == "downloading" }
      val queued = jobs.count { it["status"] == "queued" }
      val job = active.firstOrNull()
      title = if (active.size == 1) job?.get("title") as? String ?: "Downloading audio"
        else "${active.size} downloading · $queued queued"
      val progress = (job?.get("percent") as? Number)?.toDouble()
      percent = if (progress != null && job?.get("phase") == "downloading")
        progress.toInt().coerceIn(0, 100) else null
      detail = listOfNotNull(
        if (active.size > 1) job?.get("title") as? String else null,
        percent?.let { "$it%" },
        (job?.get("downloadedBytes") as? Number)?.toLong()?.let { bytes ->
          val total = (job?.get("totalBytes") as? Number)?.toLong()
          android.text.format.Formatter.formatShortFileSize(context, bytes) +
            (total?.let { " / ${android.text.format.Formatter.formatShortFileSize(context, it)}" } ?: "")
        },
        job?.get("message") as? String ?: "Waiting to download",
        if (queued > 0) "$queued queued" else null,
      ).joinToString(" · ")
      if (running) context.getSystemService(NotificationManager::class.java)
        .notify(NOTIFICATION_ID, notification(context))
    }

    private fun notification(context: android.content.Context): android.app.Notification {
      val openApp = PendingIntent.getActivity(context, 0,
        Intent(context, MainActivity::class.java).apply {
          flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
          action = "app.michoplay.desktop.OPEN_DOWNLOADS"
        }, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      return NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_stat_michoplay)
        .setContentTitle(title)
        .setContentText(detail)
        .setStyle(NotificationCompat.BigTextStyle().bigText(detail))
        .setProgress(100, percent ?: 0, percent == null)
        .setContentIntent(openApp)
        .setCategory(NotificationCompat.CATEGORY_PROGRESS)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .build()
    }
  }

  override fun onCreate() {
    super.onCreate()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Downloads",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "Shows when MichoPlay is downloading audio."
        setShowBadge(false)
      }
      getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }
    running = true
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification = notification(this)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    if (downloadWakeLock?.isHeld != true) {
      downloadWakeLock = getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:YouTubeDownload")
        .apply {
          setReferenceCounted(false)
          acquire()
        }
    }
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onTimeout(startId: Int, fgsType: Int) {
    MediaPlugin.pauseDownloadsForServiceTimeout()
    stopSelf(startId)
  }

  override fun onDestroy() {
    downloadWakeLock?.let { wakeLock ->
      if (wakeLock.isHeld) wakeLock.release()
    }
    downloadWakeLock = null
    running = false
    super.onDestroy()
  }
}
