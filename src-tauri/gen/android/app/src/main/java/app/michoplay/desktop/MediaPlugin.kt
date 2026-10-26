package app.michoplay.desktop

import android.app.Activity
import android.Manifest
import android.content.pm.PackageManager
import android.content.Intent
import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.os.storage.StorageManager
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.os.Environment
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
import org.json.JSONArray
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
    @Volatile private var notificationPermissionPrompted = false
    private val pendingActions = CopyOnWriteArrayList<String>()

    fun dispatch(action: String) {
      if (action != "youtube-downloads-updated") synchronized(pendingActions) { pendingActions.add(action) }
    }

    fun dispatchOpenAudio() = dispatch("open-audio")
  }

  override fun load(webView: android.webkit.WebView) {
    super.load(webView)
    io.execute { initializeDownloader() }
  }

  @Command
  fun takePendingActions(invoke: Invoke) {
    val actions = JSONArray()
    synchronized(pendingActions) {
      pendingActions.forEach { actions.put(it) }
      pendingActions.clear()
    }
    invoke.resolve(JSObject().apply { put("actions", actions) })
  }

  @Command
  fun chooseMusicFolder(invoke: Invoke) {
    withAudioPermission(invoke) {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        putExtra("android.content.extra.SHOW_ADVANCED", true)
      }
      activity.runOnUiThread { startActivityForResult(invoke, intent, "onMusicFolderChosen") }
    }
  }

  @Command
  fun discoverMusicFolders(invoke: Invoke) {
    withAudioPermission(invoke) {
      io.execute {
        try {
          val roots = linkedSetOf<String>()
          val projection = arrayOf(MediaStore.Audio.Media.DATA)
          activity.contentResolver.query(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, projection, null, null, null)?.use { cursor ->
            val pathColumn = cursor.getColumnIndex(MediaStore.Audio.Media.DATA)
            if (pathColumn >= 0) while (cursor.moveToNext()) {
              val path = cursor.getString(pathColumn) ?: continue
              val file = File(path)
              if (file.isFile && file.canRead() && isAudioName(file.name)) {
                libraryRootFor(file)?.let { roots.add(it.canonicalPath) }
              }
            }
          }
          invoke.resolveObject(roots.toList())
        } catch (error: Exception) { invoke.reject(error.message ?: "Could not discover music on this device.") }
      }
    }
  }

  private fun withAudioPermission(invoke: Invoke, action: () -> Unit) {
    val permission = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE
    if (ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED) {
      action()
      return
    }
    activity.runOnUiThread {
      (activity as? MainActivity)?.requestPermissions(arrayOf(permission)) { granted ->
        if (granted == true) action()
        else invoke.reject("Allow Music and audio access to use songs from their original folders.")
      } ?: invoke.reject("Music access is unavailable on this device.")
    }
  }

  private fun libraryRootFor(file: File): File? {
    val parent = file.parentFile ?: return null
    val path = file.canonicalPath
    val primary = Environment.getExternalStorageDirectory().canonicalPath
    val volumeRoot = when {
      path.startsWith("$primary/") -> primary
      path.startsWith("/storage/") -> path.split('/').take(3).joinToString("/")
      else -> return parent
    }
    val relative = path.removePrefix("$volumeRoot/")
    val topLevel = relative.substringBefore('/')
    return if (topLevel.isBlank()) parent else File(volumeRoot, topLevel)
  }

  @Command
  fun youtubeMusicDirectory(invoke: Invoke) {
    val directory = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), "MichoPlay/YouTube")
    invoke.resolve(JSObject().apply { put("path", directory.absolutePath) })
  }

  @ActivityCallback
  fun onMusicFolderChosen(invoke: Invoke, result: ActivityResult) {
    if (result.resultCode != Activity.RESULT_OK) { invoke.reject("Folder selection cancelled."); return }
    val uri = result.data?.data ?: run { invoke.reject("No folder was selected."); return }
    io.execute {
      try {
        activity.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val name = queryTreeName(uri) ?: "Imported music"
        val folder = directPathForUri(uri)?.takeIf { it.isDirectory && it.canRead() }
          ?: throw IllegalArgumentException("Choose an on-device music folder that MichoPlay can read directly.")
        val count = folder.walkTopDown().maxDepth(32).filter { it.isFile && isAudioName(it.name) }.take(5000).count()
        if (count == 0) throw IllegalArgumentException("No supported audio files were found in that folder.")
        invoke.resolve(JSObject().apply { put("path", folder.canonicalPath); put("count", count); put("name", name) })
      } catch (error: Exception) { invoke.reject(error.message ?: "Could not add that music folder.") }
    }
  }

  private fun directPathForUri(uri: Uri): File? {
    if (uri.scheme == "file") return uri.path?.let(::File)?.canonicalFile
    if (DocumentsContract.isDocumentUri(activity, uri) || DocumentsContract.isTreeUri(uri)) {
      val id = try {
        if (DocumentsContract.isTreeUri(uri)) DocumentsContract.getTreeDocumentId(uri)
        else DocumentsContract.getDocumentId(uri)
      } catch (_: Exception) { null }
      if (uri.authority == "com.android.externalstorage.documents" && id != null) {
        val volume = id.substringBefore(':')
        val relative = id.substringAfter(':', "")
        if (relative.split('/').any { it == ".." }) return null
        val base = if (volume.equals("primary", ignoreCase = true)) Environment.getExternalStorageDirectory()
          else if (Build.VERSION.SDK_INT >= 30) {
            activity.getSystemService(StorageManager::class.java).storageVolumes
              .firstOrNull { it.uuid.equals(volume, ignoreCase = true) }?.directory
          } else File("/storage/$volume")
        if (base != null) {
          val canonicalBase = base.canonicalFile
          val candidate = File(canonicalBase, relative).canonicalFile
          if (candidate == canonicalBase || candidate.path.startsWith("${canonicalBase.path}/")) return candidate
        }
      }
    }
    return try {
      activity.contentResolver.query(uri, arrayOf(MediaStore.MediaColumns.DATA), null, null, null)?.use { cursor ->
        val column = cursor.getColumnIndex(MediaStore.MediaColumns.DATA)
        if (column >= 0 && cursor.moveToFirst()) cursor.getString(column)?.let { File(it).canonicalFile } else null
      }
    } catch (_: Exception) { null }
  }

  private fun queryTreeName(tree: Uri): String? = try {
    val document = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
    activity.contentResolver.query(document, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) cursor.getString(0)?.takeIf { it.isNotBlank() } else null
    }
  } catch (_: Exception) { null }
  private fun isAudioName(name: String): Boolean = name.substringAfterLast('.', "").lowercase() in setOf("mp3", "flac", "wav", "ogg", "opus", "m4a", "aac", "aiff", "aif")

  @Command
  fun chooseAudioFiles(invoke: Invoke) {
    withAudioPermission(invoke) {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = "audio/*"
        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
      }
      activity.runOnUiThread { startActivityForResult(invoke, intent, "onAudioFilesChosen") }
    }
  }

  @ActivityCallback
  fun onAudioFilesChosen(invoke: Invoke, result: ActivityResult) {
    if (result.resultCode != Activity.RESULT_OK) { invoke.reject("Audio selection cancelled."); return }
    val uris = linkedSetOf<Uri>()
    result.data?.data?.let { uris.add(it) }
    result.data?.clipData?.let { clip -> for (index in 0 until clip.itemCount) clip.getItemAt(index).uri?.let { uris.add(it) } }
    resolveAudioPaths(invoke, uris)
  }

  private fun resolveAudioPaths(invoke: Invoke, uris: Collection<Uri>) {
    io.execute {
      try {
        val paths = linkedSetOf<String>()
        for (uri in uris.take(100)) {
          try { activity.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
          catch (_: Exception) { /* Shared audio intents can grant access only for this launch. */ }
          val file = directPathForUri(uri)?.takeIf { it.isFile && it.canRead() && isAudioName(it.name) }
            ?: throw IllegalArgumentException("Choose on-device audio that MichoPlay can read directly.")
          paths.add(file.canonicalPath)
        }
        if (paths.isEmpty()) throw IllegalArgumentException("No supported audio files were selected.")
        invoke.resolveObject(paths.toList())
      } catch (error: Exception) { invoke.reject(error.message ?: "Could not open the selected audio files.") }
    }
  }

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
        val staging = File(activity.cacheDir, "youtube/${item["id"]}")
        try {
          if (!downloaderReady && !initializeDownloader()) throw IllegalStateException(downloaderError ?: "YouTube tools couldn’t start.")
          updateDownloaderIfNeeded(item)
          staging.deleteRecursively(); staging.mkdirs()
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
            audioFiles.forEach(::publishAudioToMusic)
            item["status"] = "completed"; item["percent"] = 100.0; item["message"] = "Saved to Music/MichoPlay/YouTube"
          }
        } catch (error: Exception) {
          if (item["status"] != "paused" && item["status"] != "cancelled") { item["status"] = "failed"; item["message"] = error.message ?: "Download failed" }
        } finally { staging.deleteRecursively(); activeDownloads.decrementAndGet(); emitDownloads(); startQueuedDownloads() }
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
    if (uris.isEmpty()) { invoke.resolveObject(emptyList<String>()); return }
    withAudioPermission(invoke) {
      activity.setIntent(Intent(Intent.ACTION_MAIN))
      resolveAudioPaths(invoke, uris)
    }
  }
}
