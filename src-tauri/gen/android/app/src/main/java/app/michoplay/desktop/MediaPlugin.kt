package app.michoplay.desktop

import android.app.Activity
import android.Manifest
import android.content.pm.PackageManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import androidx.core.content.ContextCompat

@InvokeArg
class MediaUpdateArgs {
  var title: String = ""
  var artist: String = ""
  var isPlaying: Boolean = false
  var durationMs: Long = 0
  var positionMs: Long = 0
}

@TauriPlugin
class MediaPlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    @Volatile private var activePlugin: MediaPlugin? = null
    @Volatile private var notificationPermissionPrompted = false

    fun dispatch(action: String) {
      val payload = JSObject().apply { put("action", action) }
      activePlugin?.trigger("action", payload)
    }

    fun dispatchOpenAudio() = dispatch("open-audio")
  }

  override fun load(webView: android.webkit.WebView) {
    super.load(webView)
    activePlugin = this
  }

  @Command
  fun update(invoke: Invoke) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
        ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
        !notificationPermissionPrompted) {
        notificationPermissionPrompted = true
        activity.runOnUiThread {
          activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 9043)
        }
      }
      val args = invoke.parseArgs(MediaUpdateArgs::class.java)
      val intent = Intent(activity, MediaPlaybackService::class.java).apply {
        action = MediaPlaybackService.ACTION_UPDATE
        putExtra(MediaPlaybackService.EXTRA_TITLE, args.title)
        putExtra(MediaPlaybackService.EXTRA_ARTIST, args.artist)
        putExtra(MediaPlaybackService.EXTRA_PLAYING, args.isPlaying)
        putExtra(MediaPlaybackService.EXTRA_DURATION, args.durationMs)
        putExtra(MediaPlaybackService.EXTRA_POSITION, args.positionMs)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ContextCompat.startForegroundService(activity, intent)
      else activity.startService(intent)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not update Android playback controls.")
    }
  }

  @Command
  fun stop(invoke: Invoke) {
    activity.stopService(Intent(activity, MediaPlaybackService::class.java))
    invoke.resolve()
  }

  @Command
  @Suppress("DEPRECATION")
  fun takeOpenedAudio(invoke: Invoke) {
    try {
      val intent = activity.intent
      val uris = linkedSetOf<Uri>()
      when (intent?.action) {
        Intent.ACTION_VIEW -> intent.data?.let { uris.add(it) }
        Intent.ACTION_SEND -> {
          if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)?.let { uris.add(it) }
          else intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.add(it) }
        }
        Intent.ACTION_SEND_MULTIPLE -> {
          if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)?.let { uris.addAll(it) }
          else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.addAll(it) }
        }
      }
      intent?.clipData?.let { clip -> for (index in 0 until clip.itemCount) clip.getItemAt(index).uri?.let { uris.add(it) } }
      val result = mutableListOf<Map<String, String>>()
      var totalBytes = 0L
      for (uri in uris.take(100)) {
        val bytes = activity.contentResolver.openInputStream(uri)?.use { input ->
          val output = java.io.ByteArrayOutputStream()
          var fileBytes = 0L
          val buffer = ByteArray(16 * 1024)
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            fileBytes += count
            totalBytes += count
            if (fileBytes > 256L * 1024 * 1024 || totalBytes > 1024L * 1024 * 1024) throw IllegalArgumentException("Selected audio exceeds the import size limit.")
            output.write(buffer, 0, count)
          }
          output.toByteArray()
        } ?: continue
        val name = activity.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
          val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (column >= 0 && cursor.moveToFirst()) cursor.getString(column) else null
        } ?: "audio-${result.size + 1}.mp3"
        result.add(mapOf(
          "name" to name,
          "dataBase64" to Base64.encodeToString(bytes, Base64.NO_WRAP)
        ))
      }
      activity.setIntent(Intent(Intent.ACTION_MAIN))
      invoke.resolveObject(result)
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not open the selected audio files.")
    }
  }
}
