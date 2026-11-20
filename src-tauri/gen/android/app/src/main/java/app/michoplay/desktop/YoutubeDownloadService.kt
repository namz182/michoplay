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

    fun isRunning() = running
  }

  override fun onCreate() {
    super.onCreate()
    running = true
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
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val openApp = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).apply {
        this.flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      },
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_michoplay)
      .setContentTitle("MichoPlay downloads")
      .setContentText("Your audio is downloading. Tap to check progress.")
      .setContentIntent(openApp)
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .build()

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
