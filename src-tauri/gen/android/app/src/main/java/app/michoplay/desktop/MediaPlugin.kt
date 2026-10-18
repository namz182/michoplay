package app.michoplay.desktop

import android.app.Activity
import android.Manifest
import android.content.pm.PackageManager
import android.content.Intent
import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.os.Environment
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import androidx.activity.result.ActivityResult
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import androidx.core.content.ContextCompat
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import com.yausername.ffmpeg.FFmpeg
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

@InvokeArg
class MediaUpdateArgs {
  var title: String = ""
  var artist: String = ""
  var isPlaying: Boolean = false
  var durationMs: Long = 0
  var positionMs: Long = 0
  var artworkDataUrl: String? = null
}

@InvokeArg
class YoutubeSearchArgs { var query: String = "" }

@InvokeArg
class YoutubeDownloadArgs {
  var url: String = ""
  var title: String = ""
  var thumbnail: String? = null
  var isPlaylist: Boolean = false
  var estimatedBytes: Long? = null
  var id: String = ""
}

@TauriPlugin
class MediaPlugin(private val activity: Activity) : Plugin(activity) {
  private val io = Executors.newCachedThreadPool()
  private val downloads = CopyOnWriteArrayList<MutableMap<String, Any?>>()
  private val activeDownloads = AtomicInteger(0)
  private val maxConcurrentDownloads = 3
  @Volatile private var nextDownloadId = 1
  @Volatile private var downloaderReady = false
  @Volatile private var downloaderError: String? = null
  @Volatile private var downloaderUpdateAttempted = false
  companion object {
    @Volatile private var activePlugin: MediaPlugin? = null
    @Volatile private var notificationPermissionPrompted = false

    fun dispatch(action: String) {
      val plugin = activePlugin ?: return
      plugin.activity.runOnUiThread {
        val payload = JSObject().apply { put("action", action) }
        plugin.trigger("action", payload)
      }
    }

    fun dispatchOpenAudio() = dispatch("open-audio")
  }

  override fun load(webView: android.webkit.WebView) {
    super.load(webView)
    activePlugin = this
    io.execute { initializeDownloader() }
  }

  @Command
  fun chooseMusicFolder(invoke: Invoke) {
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
      putExtra("android.content.extra.SHOW_ADVANCED", true)
    }
    startActivityForResult(invoke, intent, "onMusicFolderChosen")
  }

  @Command
  fun youtubeMusicDirectory(invoke: Invoke) {
    val directory = File(activity.filesDir, "Music/YouTube")
    if (!directory.exists() && !directory.mkdirs()) { invoke.reject("MichoPlay couldn’t create its music library folder."); return }
    invoke.resolve(JSObject().apply { put("path", directory.canonicalPath) })
  }

  @ActivityCallback
  fun onMusicFolderChosen(invoke: Invoke, result: ActivityResult) {
    if (result.resultCode != Activity.RESULT_OK) { invoke.reject("Folder selection cancelled."); return }
    val uri = result.data?.data ?: run { invoke.reject("No folder was selected."); return }
    io.execute {
      try {
        activity.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val name = queryTreeName(uri) ?: "Imported music"
        val destination = File(activity.filesDir, "Music/Imported/${safeName(name)}")
        if (!destination.exists()) destination.mkdirs()
        val copied = copyAudioTree(uri, destination)
        if (copied == 0) { invoke.reject("No supported audio files were found in that folder."); return@execute }
        invoke.resolve(JSObject().apply { put("path", destination.canonicalPath); put("count", copied); put("name", name) })
      } catch (error: Exception) { invoke.reject(error.message ?: "Could not import that music folder.") }
    }
  }

  private fun copyAudioTree(tree: Uri, target: File): Int {
    var copied = 0
    val rootId = DocumentsContract.getTreeDocumentId(tree)
    fun visit(parentId: String, destination: File, depth: Int) {
      if (depth > 32 || copied >= 5000) return
      val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId)
      activity.contentResolver.query(children, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE), null, null, null)?.use { cursor ->
        val idCol = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
        val nameCol = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
        val mimeCol = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
        while (cursor.moveToNext() && copied < 5000) {
          val id = cursor.getString(idCol)
          val name = safeName(cursor.getString(nameCol) ?: "audio")
          val mime = if (mimeCol >= 0) cursor.getString(mimeCol) else null
          if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
            val child = File(destination, name).apply { mkdirs() }
            visit(id, child, depth + 1)
          } else if (isAudioName(name)) {
            val doc = DocumentsContract.buildDocumentUriUsingTree(tree, id)
            val outputFile = File(destination, name)
            activity.contentResolver.openInputStream(doc)?.use { input -> outputFile.outputStream().use { input.copyTo(it) } }
            if (outputFile.isFile) copied++
          }
        }
      }
    }
    visit(rootId, target, 0)
    return copied
  }

  private fun queryTreeName(tree: Uri): String? = try {
    val document = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
    activity.contentResolver.query(document, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) cursor.getString(0)?.takeIf { it.isNotBlank() } else null
    }
  } catch (_: Exception) { null }
  private fun safeName(value: String): String = value.replace(Regex("[\\\\/:*?\"<>|]"), "_").trim().ifEmpty { "Music" }
  private fun isAudioName(name: String): Boolean = name.substringAfterLast('.', "").lowercase() in setOf("mp3", "flac", "wav", "ogg", "opus", "m4a", "aac", "aiff", "aif")

  @Command
  fun youtubeSearch(invoke: Invoke) {
    val query = invoke.parseArgs(YoutubeSearchArgs::class.java).query.trim()
    if (query.isEmpty() || query.length > 200) { invoke.reject("Enter a YouTube search or link (up to 200 characters)."); return }
    io.execute {
      try {
        if (!downloaderReady) throw IllegalStateException("YouTube tools are still starting. Try again in a moment.")
        val isUrl = query.startsWith("https://") || query.startsWith("http://")
        if (isUrl && !isYoutubeUrl(query)) throw IllegalArgumentException("Enter a valid YouTube video or playlist URL.")
        val isPlaylist = isUrl && query.contains("list=")
        val request = YoutubeDLRequest(if (isUrl) query else "ytsearch10:$query")
        request.addOption("--ignore-config"); request.addOption("--no-warnings"); request.addOption("--flat-playlist")
        request.addOption("--dump-single-json"); request.addOption("--playlist-end", "10"); request.addOption("--skip-download")
        val json = JSONObject(YoutubeDL.getInstance().execute(request).out)
        val results = mutableListOf<Map<String, Any?>>()
        if (isPlaylist) {
          val id = json.optString("id", "playlist")
          results.add(mapOf("id" to id, "title" to json.optString("title", "YouTube playlist"), "url" to query, "thumbnail" to json.optString("thumbnail").takeIf { it.startsWith("https://") }, "durationSeconds" to null, "isPlaylist" to true))
        } else {
          val entries = json.optJSONArray("entries")
          if (entries == null) addSearchEntry(results, json) else for (index in 0 until minOf(entries.length(), 10)) addSearchEntry(results, entries.optJSONObject(index) ?: JSONObject())
        }
        invoke.resolveObject(results)
      } catch (error: Exception) { invoke.reject(error.message ?: "YouTube search failed.") }
    }
  }

  private fun addSearchEntry(results: MutableList<Map<String, Any?>>, entry: JSONObject) {
    val id = entry.optString("id").takeIf { it.isNotBlank() } ?: return
    val title = entry.optString("title").trim().takeIf { it.isNotBlank() } ?: return
    val url = entry.optString("webpage_url").takeIf { isYoutubeUrl(it) } ?: "https://www.youtube.com/watch?v=$id"
    val duration = entry.opt("duration").takeIf { it is Number } as? Number
    results.add(mapOf("id" to id, "title" to title, "url" to url, "thumbnail" to (entry.optString("thumbnail").takeIf { it.startsWith("https://") } ?: "https://i.ytimg.com/vi/$id/hqdefault.jpg"), "durationSeconds" to duration?.toDouble(), "isPlaylist" to false))
  }

  private fun isYoutubeUrl(raw: String): Boolean = try {
    val uri = Uri.parse(raw)
    uri.scheme in listOf("https", "http") && (uri.host == "youtube.com" || uri.host == "www.youtube.com" || uri.host == "m.youtube.com" || uri.host == "music.youtube.com" || uri.host == "youtu.be" || uri.host == "www.youtu.be")
  } catch (_: Exception) { false }

  @Command
  fun youtubeDownloadsState(invoke: Invoke) = invoke.resolveObject(downloads.toList())

  @Command
  fun youtubeDownloadEnqueue(invoke: Invoke) {
    val args = invoke.parseArgs(YoutubeDownloadArgs::class.java)
    if (!isYoutubeUrl(args.url)) { invoke.reject("Enter a valid YouTube video or playlist URL."); return }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && ContextCompat.checkSelfPermission(activity, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
      activity.runOnUiThread { activity.requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), 9044) }
      invoke.reject("Allow storage access, then tap Download again.")
      return
    }
    val item = mutableMapOf<String, Any?>("id" to "youtube-${nextDownloadId++}", "title" to args.title.ifBlank { "YouTube audio" }, "url" to args.url, "thumbnail" to args.thumbnail, "isPlaylist" to (args.isPlaylist && args.url.contains("list=")), "estimatedBytes" to args.estimatedBytes, "status" to "queued", "percent" to null, "downloadedBytes" to null, "totalBytes" to null, "message" to "Waiting to download")
    downloads.add(item); emitDownloads(); invoke.resolveObject(item); startQueuedDownloads()
  }

  @Synchronized
  private fun startQueuedDownloads() {
    while (activeDownloads.get() < maxConcurrentDownloads) {
      val item = downloads.firstOrNull { it["status"] == "queued" } ?: return
      activeDownloads.incrementAndGet()
      item["status"] = "downloading"; item["message"] = ""; emitDownloads()
      io.execute {
        try {
          if (!downloaderReady && !initializeDownloader()) throw IllegalStateException(downloaderError ?: "YouTube tools couldn’t start.")
          updateDownloaderIfNeeded(item)
          val root = File(activity.filesDir, "Music/YouTube").apply { mkdirs() }
          val staging = File(activity.cacheDir, "youtube/${item["id"]}").apply { deleteRecursively(); mkdirs() }
          val request = YoutubeDLRequest(item["url"] as String)
          request.addOption("--ignore-config"); request.addOption("--no-warnings"); request.addOption("--newline")
          if (item["isPlaylist"] == true) request.addOption("--yes-playlist") else request.addOption("--no-playlist")
          request.addOption("--playlist-end", "100")
          request.addOption("-f", "bestaudio[ext=m4a]/bestaudio")
          request.addOption("-x"); request.addOption("--audio-format", "m4a"); request.addOption("--embed-metadata")
          request.addOption("--embed-thumbnail")
          request.addOption("-o", File(staging, "%(title).180B [%(id)s].%(ext)s").absolutePath)
          YoutubeDL.getInstance().execute(request, item["id"] as String) { progress, _, line ->
            val percent = progress.toDouble().coerceIn(0.0, 100.0)
            item["percent"] = percent
            val totalMatch = Regex("of\\s+([0-9]+(?:\\.[0-9]+)?)\\s*(KiB|MiB|GiB|KB|MB|GB|B)").find(line)
            if (totalMatch != null) item["totalBytes"] = toByteCount(totalMatch.groupValues[1], totalMatch.groupValues[2])
            val downloadedMatch = Regex("([0-9]+(?:\\.[0-9]+)?)\\s*(KiB|MiB|GiB|KB|MB|GB|B)\\s*/").find(line)
            val totalBytes = item["totalBytes"] as? Long
            val downloadedBytes = if (downloadedMatch != null) {
              toByteCount(downloadedMatch.groupValues[1], downloadedMatch.groupValues[2])
            } else if (totalBytes != null) {
              (totalBytes * percent / 100.0).toLong()
            } else null
            if (downloadedBytes != null) item["downloadedBytes"] = downloadedBytes
            val speed = Regex("at\\s+([0-9]+(?:\\.[0-9]+)?\\s*[KMG]?i?B/s)").find(line)?.groupValues?.get(1)
            if (speed != null) item["message"] = speed else if (item["message"] !is String || !(item["message"] as String).endsWith("/s")) item["message"] = ""
            emitDownloads()
            kotlin.Unit
          }
          if (item["status"] != "paused" && item["status"] != "cancelled") {
            val audioFiles = staging.walkTopDown().filter { it.isFile && isAudioName(it.name) }.toList()
            if (audioFiles.isEmpty()) throw IllegalStateException("YouTube did not produce a playable audio file.")
            audioFiles.forEach { source ->
              val libraryCopy = File(root, source.name)
              source.copyTo(libraryCopy, overwrite = true)
              publishAudioToMusic(libraryCopy)
            }
            item["status"] = "completed"; item["percent"] = 100.0; item["message"] = "Saved to Music/MichoPlay/YouTube"
          }
          staging.deleteRecursively()
        } catch (error: Exception) {
          if (item["status"] != "paused" && item["status"] != "cancelled") { item["status"] = "failed"; item["message"] = error.message ?: "Download failed" }
        } finally { activeDownloads.decrementAndGet(); emitDownloads(); startQueuedDownloads() }
      }
    }
  }

  private fun emitDownloads() = dispatch("youtube-downloads-updated")

  private fun toByteCount(value: String, unit: String): Long {
    val base = if (unit.endsWith("iB")) 1024.0 else 1000.0
    val power = when (unit) { "KiB", "KB" -> 1.0; "MiB", "MB" -> 2.0; "GiB", "GB" -> 3.0; else -> 0.0 }
    return ((value.toDoubleOrNull() ?: 0.0) * Math.pow(base, power)).toLong()
  }

  @Synchronized
  private fun initializeDownloader(): Boolean {
    if (downloaderReady) return true
    return try {
      YoutubeDL.getInstance().init(activity.applicationContext)
      FFmpeg.getInstance().init(activity.applicationContext)
      downloaderError = null
      downloaderReady = true
      true
    } catch (error: Exception) {
      downloaderError = error.message ?: "YouTube tools could not initialize."
      false
    }
  }

  @Synchronized
  private fun updateDownloaderIfNeeded(item: MutableMap<String, Any?>) {
    if (downloaderUpdateAttempted) return
    try {
      YoutubeDL.getInstance().updateYoutubeDL(activity.applicationContext, YoutubeDL.UpdateChannel.NIGHTLY)
    } catch (error: Exception) {
      // The bundled extractor remains usable if the update server is unavailable.
      downloaderError = "YouTube support update failed: ${error.message ?: "network unavailable"}"
    } finally {
      downloaderUpdateAttempted = true
    }
  }

  private fun publishAudioToMusic(file: File) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      val directory = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), "MichoPlay/YouTube")
      if (!directory.exists() && !directory.mkdirs()) throw IllegalStateException("Android couldn’t create Music/MichoPlay/YouTube.")
      file.copyTo(File(directory, file.name), overwrite = true)
      return
    }
    val values = ContentValues().apply {
      put(MediaStore.Audio.Media.DISPLAY_NAME, file.name)
      put(MediaStore.Audio.Media.TITLE, file.nameWithoutExtension)
      put(MediaStore.Audio.Media.MIME_TYPE, "audio/mp4")
      put(MediaStore.Audio.Media.RELATIVE_PATH, "${Environment.DIRECTORY_MUSIC}/MichoPlay/YouTube")
      put(MediaStore.Audio.Media.IS_PENDING, 1)
    }
    val uri = activity.contentResolver.insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, values)
      ?: throw IllegalStateException("Android couldn’t create a file in the Music folder.")
    try {
      activity.contentResolver.openOutputStream(uri, "w")?.use { output -> file.inputStream().use { input -> input.copyTo(output) } }
        ?: throw IllegalStateException("Android couldn’t open the new Music file.")
      ContentValues().apply { put(MediaStore.Audio.Media.IS_PENDING, 0) }.also { activity.contentResolver.update(uri, it, null, null) }
    } catch (error: Exception) {
      activity.contentResolver.delete(uri, null, null)
      throw error
    }
  }

  @Command
  fun youtubeDownloadPause(invoke: Invoke) = changeDownload(invoke, "paused", stop = true)
  @Command
  fun youtubeDownloadResume(invoke: Invoke) = changeDownload(invoke, "queued", stop = false)
  @Command
  fun youtubeDownloadCancel(invoke: Invoke) = changeDownload(invoke, "cancelled", stop = true)
  @Command
  fun youtubeDownloadRemove(invoke: Invoke) {
    val id = invoke.parseArgs(YoutubeDownloadArgs::class.java).id
    downloads.removeAll { it["id"] == id && it["status"] != "downloading" }
    emitDownloads(); invoke.resolve()
  }
  private fun changeDownload(invoke: Invoke, status: String, stop: Boolean) {
    val id = invoke.parseArgs(YoutubeDownloadArgs::class.java).id
    val item = downloads.firstOrNull { it["id"] == id } ?: run { invoke.reject("Download was not found."); return }
    item["status"] = status
    if (status == "queued") { item["message"] = "Waiting to resume"; startQueuedDownloads() }
    else if (stop) { item["message"] = if (status == "paused") "Paused" else "Cancelled"; try { YoutubeDL.getInstance().destroyProcessById(id) } catch (_: Exception) {} }
    emitDownloads(); invoke.resolve()
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
        putExtra(MediaPlaybackService.EXTRA_ARTWORK, args.artworkDataUrl)
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
