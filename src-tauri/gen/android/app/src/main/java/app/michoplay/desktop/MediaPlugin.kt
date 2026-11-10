package app.michoplay.desktop

import android.app.Activity
import android.Manifest
import android.content.pm.PackageManager
import android.content.Intent
import android.content.ContentUris
import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.os.storage.StorageManager
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.media.MediaScannerConnection
import android.media.MediaMetadataRetriever
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
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.IOException
import java.nio.charset.Charset
import java.util.concurrent.Executors
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.ConcurrentHashMap
import java.util.Collections

@InvokeArg
class MediaUpdateArgs {
  var title: String = ""
  var artist: String = ""
  var isPlaying: Boolean = false
  var durationMs: Long = 0
  var positionMs: Long = 0
  var artworkPath: String? = null
  var interrupted: Boolean = false
  var focusGeneration: Long = 0
  var trackId: Long = -1
  var isFavorite: Boolean = false
}

@InvokeArg
class YoutubeSearchArgs { var query: String = ""; var limit: Int = 15; var offset: Int = 0; var includeLyrics: Boolean = false; var playlistItems: Boolean = false }

@InvokeArg
class YoutubeDownloadArgs {
  var url: String = ""
  var title: String = ""
  var thumbnail: String? = null
  var isPlaylist: Boolean = false
  var playlistId: String? = null
  var playlistTitle: String? = null
  var playlistIndex: Int? = null
  var playlistTotal: Int? = null
  var id: String = ""
}

@InvokeArg
class ShareTextArgs {
  var title: String = ""
  var text: String = ""
  var url: String = ""
}

@InvokeArg
class MetadataFileAccessArgs { var path: String = "" }

@InvokeArg
class MetadataFileWriteArgs { var path: String = ""; var tempPath: String = "" }

@TauriPlugin
class MediaPlugin(private val activity: Activity) : Plugin(activity) {
  private val io = Executors.newCachedThreadPool()
  private val downloads = CopyOnWriteArrayList<MutableMap<String, Any?>>()
  private val jobGenerations = ConcurrentHashMap<String, AtomicInteger>()
  private val activeDownloads = AtomicInteger(0)
  private val downloadQueueLock = Any()
  // Keep native extraction and FFmpeg from starving the Android UI thread.
  private val maxConcurrentDownloads = 1
  private val nextDownloadId = AtomicInteger(1)
  @Volatile private var downloaderReady = false
  @Volatile private var downloaderError: String? = null
  @Volatile private var downloader403RefreshAttempted = false
  private var lastDownloadUpdateMs = 0L
  private var lastDownloadPersistMs = 0L
  private var lastDownloadStates = ""
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
    restoreDownloads()
    io.execute { initializeDownloader(); startQueuedDownloads() }
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
  fun shareText(invoke: Invoke) {
    val args = invoke.parseArgs(ShareTextArgs::class.java)
    val title = args.title.trim().ifBlank { "MichoPlay" }
    val text = buildString {
      if (args.text.isNotBlank()) append(args.text.trim())
      if (args.url.isNotBlank()) {
        if (isNotEmpty()) append("\n\n")
        append(args.url.trim())
      }
    }
    if (text.isBlank()) {
      invoke.reject("Nothing to share.")
      return
    }
    activity.runOnUiThread {
      try {
        val shareIntent = Intent(Intent.ACTION_SEND).apply {
          type = "text/plain"
          putExtra(Intent.EXTRA_TITLE, title)
          putExtra(Intent.EXTRA_SUBJECT, title)
          putExtra(Intent.EXTRA_TEXT, text)
        }
        activity.startActivity(Intent.createChooser(shareIntent, "Share MichoPlay"))
        invoke.resolve()
      } catch (error: Exception) {
        invoke.reject(error.message ?: "Could not open the Android share menu.")
      }
    }
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
    // Android/data and Android/obb are protected by scoped storage. Never
    // promote their files to a broad Android/ scan root; users can still add
    // a readable folder explicitly through the system folder picker.
    if (topLevel.equals("Android", ignoreCase = true)) return null
    return if (topLevel.isBlank()) parent else File(volumeRoot, topLevel)
  }

  @Command
  fun youtubeMusicDirectory(invoke: Invoke) {
    val directory = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), "MichoPlay")
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

  @Command
  fun requestMetadataWriteAccess(invoke: Invoke) {
    val args = invoke.parseArgs(MetadataFileAccessArgs::class.java)
    val expectedPath = try { File(args.path).canonicalPath } catch (_: Exception) {
      invoke.reject("This song's file path is unavailable."); return
    }
    val mainActivity = activity as? MainActivity
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
        ContextCompat.checkSelfPermission(activity, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
        if (mainActivity == null) { invoke.reject("Android could not request permission to edit this song."); return }
        mainActivity.requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE)) { granted ->
          if (granted == true) {
            activity.getSharedPreferences("michoplay_metadata", Activity.MODE_PRIVATE)
              .edit().putString(expectedPath, Uri.fromFile(File(expectedPath)).toString()).apply()
            invoke.resolve()
          } else invoke.reject("Allow storage access to edit this song file.")
        }
      } else {
        activity.getSharedPreferences("michoplay_metadata", Activity.MODE_PRIVATE)
          .edit().putString(expectedPath, Uri.fromFile(File(expectedPath)).toString()).apply()
        invoke.resolve()
      }
      return
    }

    val mediaUri = try { mediaStoreAudioUri(expectedPath) } catch (_: Exception) { null }
    if (mediaUri == null) {
      invoke.reject("Android could not find this song in its audio library, so it cannot request edit access.")
      return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val pendingIntent = try { MediaStore.createWriteRequest(activity.contentResolver, listOf(mediaUri)) }
      catch (error: Exception) { invoke.reject(error.message ?: "Android could not request permission to edit this song."); return }
      if (mainActivity == null) { invoke.reject("Android could not open the media edit permission prompt."); return }
      activity.runOnUiThread {
        mainActivity.requestMediaWriteAccess(pendingIntent.intentSender) { approved ->
          if (approved) {
            activity.getSharedPreferences("michoplay_metadata", Activity.MODE_PRIVATE)
              .edit().putString(expectedPath, mediaUri.toString()).apply()
            invoke.resolve()
          } else invoke.reject("Android did not approve editing this song.")
        }
      }
      return
    }

    io.execute {
      try {
        activity.contentResolver.openFileDescriptor(mediaUri, "rw")?.use { }
          ?: throw IllegalStateException("Android could not open this song for editing.")
        activity.getSharedPreferences("michoplay_metadata", Activity.MODE_PRIVATE)
          .edit().putString(expectedPath, mediaUri.toString()).apply()
        invoke.resolve()
      } catch (error: android.app.RecoverableSecurityException) {
        if (mainActivity == null) { invoke.reject("Android could not open the media edit permission prompt."); return@execute }
        activity.runOnUiThread {
          mainActivity.requestMediaWriteAccess(error.userAction.actionIntent.intentSender) { approved ->
            if (approved) {
              activity.getSharedPreferences("michoplay_metadata", Activity.MODE_PRIVATE)
                .edit().putString(expectedPath, mediaUri.toString()).apply()
              invoke.resolve()
            } else invoke.reject("Android did not approve editing this song.")
          }
        }
      } catch (error: Exception) { invoke.reject(error.message ?: "Could not request permission to edit this song.") }
    }
  }

  @Command
  fun writeMetadataFile(invoke: Invoke) {
    val args = invoke.parseArgs(MetadataFileWriteArgs::class.java)
    io.execute {
      try {
        val expectedPath = File(args.path).canonicalPath
        val uriValue = activity.getSharedPreferences("michoplay_metadata", Activity.MODE_PRIVATE).getString(expectedPath, null)
          ?: throw IllegalStateException("Request Android edit permission before saving metadata.")
        val uri = Uri.parse(uriValue)
        if (directPathForUri(uri)?.canonicalPath != expectedPath) {
          throw IllegalStateException("Android's file access expired. Choose the song again to continue.")
        }
        val source = File(args.tempPath)
        if (!source.isFile || !source.canRead()) throw IllegalArgumentException("The edited song could not be prepared.")
        copyEditedSong(source, uri)
        MediaScannerConnection.scanFile(activity, arrayOf(expectedPath), null, null)
        invoke.resolve()
      } catch (error: Exception) { invoke.reject(error.message ?: "Could not write metadata to the song file.") }
    }
  }

  @Command
  fun deleteAudioFile(invoke: Invoke) {
    val args = invoke.parseArgs(MetadataFileAccessArgs::class.java)
    val expectedPath = try { File(args.path).canonicalPath } catch (_: Exception) {
      invoke.reject("This song's file path is unavailable."); return
    }
    val mainActivity = activity as? MainActivity
    fun finishDelete() {
      activity.getSharedPreferences("michoplay_metadata", Activity.MODE_PRIVATE)
        .edit().remove(expectedPath).apply()
      MediaScannerConnection.scanFile(activity, arrayOf(expectedPath), null, null)
      invoke.resolve()
    }
    fun deleteLegacyFile() {
      io.execute {
        try {
          if (!File(expectedPath).delete()) throw IllegalStateException("Android could not delete this song file.")
          finishDelete()
        } catch (error: Exception) { invoke.reject(error.message ?: "Could not delete this song file.") }
      }
    }

    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
        ContextCompat.checkSelfPermission(activity, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
        if (mainActivity == null) { invoke.reject("Android could not request permission to delete this song."); return }
        mainActivity.requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE)) { granted ->
          if (granted == true) deleteLegacyFile()
          else invoke.reject("Allow storage access to delete this song file.")
        }
      } else deleteLegacyFile()
      return
    }

    val mediaUri = try { mediaStoreAudioUri(expectedPath) } catch (_: Exception) { null }
    if (mediaUri == null) {
      invoke.reject("Android could not find this song in its audio library, so it cannot delete it.")
      return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val pendingIntent = try { MediaStore.createDeleteRequest(activity.contentResolver, listOf(mediaUri)) }
      catch (error: Exception) { invoke.reject(error.message ?: "Android could not request permission to delete this song."); return }
      if (mainActivity == null) { invoke.reject("Android could not open the media delete permission prompt."); return }
      activity.runOnUiThread {
        mainActivity.requestMediaWriteAccess(pendingIntent.intentSender) { approved ->
          if (approved) finishDelete()
          else invoke.reject("Android did not approve deleting this song.")
        }
      }
      return
    }

    io.execute {
      try {
        val deleted = activity.contentResolver.delete(mediaUri, null, null)
        if (deleted <= 0) throw IllegalStateException("Android could not delete this song file.")
        finishDelete()
      } catch (error: android.app.RecoverableSecurityException) {
        if (mainActivity == null) { invoke.reject("Android could not open the media delete permission prompt."); return@execute }
        activity.runOnUiThread {
          mainActivity.requestMediaWriteAccess(error.userAction.actionIntent.intentSender) { approved ->
            if (!approved) { invoke.reject("Android did not approve deleting this song."); return@requestMediaWriteAccess }
            io.execute {
              try {
                val deleted = activity.contentResolver.delete(mediaUri, null, null)
                if (deleted <= 0) throw IllegalStateException("Android could not delete this song file.")
                finishDelete()
              } catch (retryError: Exception) { invoke.reject(retryError.message ?: "Could not delete this song file.") }
            }
          }
        }
      } catch (error: Exception) { invoke.reject(error.message ?: "Could not delete this song file.") }
    }
  }

  private fun copyEditedSong(source: File, uri: Uri) {
    if (uri.scheme == "file") {
      val target = File(uri.path ?: throw IllegalArgumentException("The song file path is unavailable."))
      source.inputStream().use { input -> target.outputStream().use { input.copyTo(it) } }
      return
    }
    val output = activity.contentResolver.openOutputStream(uri, "wt")
      ?: throw IllegalStateException("Android could not open this song for writing.")
    source.inputStream().use { input -> output.use { input.copyTo(it) } }
  }

  private fun mediaStoreAudioUri(path: String): Uri? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
    val collection = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
    val projection = arrayOf(MediaStore.Audio.Media._ID)
    val selection = "${MediaStore.Audio.Media.DATA} = ?"
    return activity.contentResolver.query(collection, projection, selection, arrayOf(path), null)?.use { cursor ->
      if (!cursor.moveToFirst()) null
      else ContentUris.withAppendedId(collection, cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)))
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
    val args = invoke.parseArgs(YoutubeSearchArgs::class.java)
    val query = args.query.trim()
    val limit = args.limit.coerceIn(1, if (args.playlistItems) 100 else 30)
    val offset = args.offset.coerceIn(0, if (args.playlistItems) 5000 else 50)
    val searchEnd = (offset + limit).coerceAtMost(if (args.playlistItems) 5000 else 50)
    if (query.isEmpty() || query.length > 200) { invoke.reject("Enter a YouTube search or link (up to 200 characters)."); return }
    io.execute {
      try {
        if (!downloaderReady) throw IllegalStateException("YouTube tools are still starting. Try again in a moment.")
        val isUrl = query.startsWith("https://") || query.startsWith("http://")
        if (isUrl && !isYoutubeUrl(query)) throw IllegalArgumentException("Enter a valid YouTube video or playlist URL.")
        val isPlaylist = isUrl && query.contains("list=")
        val request = YoutubeDLRequest(if (isUrl) query else "ytsearch$searchEnd:$query")
        request.addOption("--ignore-config"); request.addOption("--no-warnings"); if (isPlaylist || !args.includeLyrics) request.addOption("--flat-playlist")
        request.addOption("--dump-single-json"); request.addOption("--playlist-end", searchEnd.toString()); request.addOption("--skip-download")
        val json = JSONObject(YoutubeDL.getInstance().execute(request).out)
        val results = mutableListOf<Map<String, Any?>>()
        if (isPlaylist && !args.playlistItems) {
          val id = json.optString("id", "playlist")
          results.add(mapOf("id" to id, "title" to json.optString("title", "YouTube playlist"), "url" to query, "thumbnail" to json.optString("thumbnail").takeIf { it.startsWith("https://") }, "durationSeconds" to null, "isPlaylist" to true, "hasLyrics" to false))
        } else {
          val entries = json.optJSONArray("entries")
          if (entries == null) addSearchEntry(results, json) else for (index in offset until minOf(entries.length(), offset + limit)) addSearchEntry(results, entries.optJSONObject(index) ?: JSONObject())
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
    results.add(mapOf("id" to id, "title" to title, "url" to url, "thumbnail" to (entry.optString("thumbnail").takeIf { it.startsWith("https://") } ?: "https://i.ytimg.com/vi/$id/hqdefault.jpg"), "durationSeconds" to duration?.toDouble(), "isPlaylist" to false, "hasLyrics" to hasEnglishCaptions(entry)))
  }

  private fun hasEnglishCaptions(entry: JSONObject): Boolean = listOf("subtitles", "automatic_captions").any { field ->
    val captions = entry.optJSONObject(field) ?: return@any false
    val keys = captions.keys()
    while (keys.hasNext()) {
      val language = keys.next()
      val formats = captions.optJSONArray(language)
      if (language.lowercase().startsWith("en") && formats != null && (0 until formats.length()).any { formats.optJSONObject(it)?.optString("ext") == "vtt" }) return@any true
    }
    false
  }

  private fun isYoutubeUrl(raw: String): Boolean = try {
    val uri = Uri.parse(raw)
    uri.scheme in listOf("https", "http") && (uri.host == "youtube.com" || uri.host == "www.youtube.com" || uri.host == "m.youtube.com" || uri.host == "music.youtube.com" || uri.host == "youtu.be" || uri.host == "www.youtu.be")
  } catch (_: Exception) { false }

  @Command
  fun youtubeDownloadsState(invoke: Invoke) = invoke.resolveObject(downloads.map { synchronized(it) { it.toMap() } })

  @Command
  fun youtubeDownloadEnqueue(invoke: Invoke) {
    val args = invoke.parseArgs(YoutubeDownloadArgs::class.java)
    if (!isYoutubeUrl(args.url)) { invoke.reject("Enter a valid YouTube video or playlist URL."); return }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && ContextCompat.checkSelfPermission(activity, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
      activity.runOnUiThread { activity.requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), 9044) }
      invoke.reject("Allow storage access, then tap Download again.")
      return
    }
    val playlist = if (!args.playlistId.isNullOrBlank() && !args.playlistTitle.isNullOrBlank()) mapOf("id" to args.playlistId, "title" to args.playlistTitle, "index" to (args.playlistIndex ?: 0), "total" to (args.playlistTotal ?: 0)) else null
    val item = Collections.synchronizedMap(mutableMapOf<String, Any?>("id" to "youtube-${nextDownloadId.getAndIncrement()}", "title" to args.title.ifBlank { "YouTube audio" }, "url" to args.url, "thumbnail" to args.thumbnail, "isPlaylist" to (args.isPlaylist && args.url.contains("list=")), "playlist" to playlist, "status" to "queued", "phase" to "queued", "percent" to null, "downloadedBytes" to null, "totalBytes" to null, "totalBytesEstimated" to false, "speedBytesPerSecond" to null, "etaSeconds" to null, "message" to "Waiting to download", "filePaths" to emptyList<String>()))
    downloads.add(item); jobGenerations[item["id"] as String] = AtomicInteger(0)
    emitDownloads(true); invoke.resolveObject(item); startQueuedDownloads()
  }

  private fun startQueuedDownloads() {
    while (true) {
      val item = synchronized(downloadQueueLock) {
        if (activeDownloads.get() >= maxConcurrentDownloads) null
        else downloads.firstOrNull { it["status"] == "queued" }?.also {
          activeDownloads.incrementAndGet()
          it["status"] = "downloading"
          it["phase"] = "preparing"
          it["percent"] = null
          it["downloadedBytes"] = null
          it["totalBytes"] = null
          it["totalBytesEstimated"] = false
          it["speedBytesPerSecond"] = null
          it["etaSeconds"] = null
          it["message"] = "Starting download…"
        }
      } ?: return
      val generation = jobGenerations.getOrPut(item["id"] as String) { AtomicInteger(0) }.get()
      emitDownloads(true)
      io.execute {
        val staging = File(activity.cacheDir, "youtube/${item["id"]}")
        val published = mutableListOf<PublishedAudio>()
        try {
          try { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND) } catch (_: Exception) { }
          if (!downloaderReady && !initializeDownloader()) throw IllegalStateException(downloaderError ?: "YouTube tools couldn’t start.")
          staging.mkdirs()
          try {
            executeYoutubeAudioDownload(item, staging, generation)
          } catch (firstError: Exception) {
            if (!isYoutubeCompatibilityFailure(firstError)) throw firstError
            requireActiveJob(item, generation)

            // A fresh yt-dlp often fixes YouTube's frequently changing player
            // signatures. If the same client is still denied, retry with
            // clients that do not require a GVS PO token.
            item["message"] = "Refreshing YouTube support…"
            emitDownloads()
            val refreshed = refreshDownloaderForCompatibility()
            requireActiveJob(item, generation)
            if (refreshed) {
              try {
                executeYoutubeAudioDownload(item, staging, generation)
              } catch (refreshError: Exception) {
                if (!isYoutubeCompatibilityFailure(refreshError)) throw refreshError
                requireActiveJob(item, generation)
                item["message"] = "Trying another YouTube stream…"
                emitDownloads()
                executeYoutubeAudioDownload(item, staging, generation, "android_vr,web_embedded")
              }
            } else {
              item["message"] = "Trying another YouTube stream…"
              emitDownloads()
              executeYoutubeAudioDownload(item, staging, generation, "android_vr,web_embedded")
            }
          }
          if (jobIsActive(item, generation)) {
            item["phase"] = "verifying"; item["message"] = "Checking the downloaded audio…"; emitDownloads()
            val audioFiles = staging.walkTopDown().filter { it.isFile && it.extension.equals("mp3", ignoreCase = true) }.toList()
            if (audioFiles.isEmpty()) throw IllegalStateException("YouTube did not produce a playable audio file.")
            val filePaths = audioFiles.map { audio ->
              requireActiveJob(item, generation)
              requirePlayableAudio(audio)
              val lyric = staging.walkTopDown().firstOrNull { file -> file.isFile && (file.extension.equals("lrc", true) || file.extension.equals("vtt", true)) && (file.nameWithoutExtension == audio.nameWithoutExtension || file.nameWithoutExtension.startsWith(audio.nameWithoutExtension + ".")) }
              if (lyric != null) {
                item["phase"] = "lyrics"; item["message"] = "Fetching and embedding lyrics…"; emitDownloads()
                val text = lyric.readText()
                val synchronizedLyrics = if (lyric.extension.equals("vtt", true)) vttToLrc(text) else text
                if (synchronizedLyrics.isNotBlank() && !embedLyricsInMp3(audio, synchronizedLyrics)) {
                  throw IllegalStateException("Could not embed the downloaded lyrics in the MP3.")
                }
              }
              requireActiveJob(item, generation)
              item["phase"] = "saving"; item["message"] = "Saving audio to Music…"; emitDownloads()
              val saved = publishAudioToMusic(audio, item, generation)
              published.add(saved)
              requireActiveJob(item, generation)
              saved.path
            }
            val finalBytes = audioFiles.sumOf { it.length() }
            synchronized(item) {
              requireActiveJob(item, generation)
              item["downloadedBytes"] = finalBytes; item["totalBytes"] = finalBytes
              item["speedBytesPerSecond"] = null; item["etaSeconds"] = null
              item["filePaths"] = filePaths
              item["status"] = "completed"; item["phase"] = "completed"; item["percent"] = 100.0; item["message"] = "Completed"
            }
          }
        } catch (error: Exception) {
          published.filter { it.created }.forEach { saved ->
            runCatching { if (saved.uri != null) activity.contentResolver.delete(saved.uri, null, null) else File(saved.path).delete() }
          }
          // A pause followed quickly by resume changes the item to queued before
          // this process exits. Do not let the old worker overwrite that request.
          if (jobIsActive(item, generation)) { item["status"] = "failed"; item["phase"] = "failed"; item["message"] = error.message ?: "Download failed" }
        } finally {
          if (item["status"] == "completed" || item["status"] == "cancelled") staging.deleteRecursively()
          activeDownloads.decrementAndGet(); emitDownloads(true); startQueuedDownloads()
        }
      }
    }
  }

  private fun executeYoutubeAudioDownload(item: MutableMap<String, Any?>, staging: File, generation: Int, playerClients: String? = null) {
    val request = YoutubeDLRequest(item["url"] as String)
    request.addOption("--ignore-config"); request.addOption("--ignore-errors"); request.addOption("--no-warnings"); request.addOption("--no-colors"); request.addOption("--newline"); request.addOption("--progress"); request.addOption("--continue")
    // Mobile networks often change between search and download. Let yt-dlp retry
    // short connection failures instead of immediately failing the whole job.
    request.addOption("--retries", "5"); request.addOption("--fragment-retries", "5")
    request.addOption("--extractor-retries", "3"); request.addOption("--socket-timeout", "30")
    request.addOption("--progress-template", "download:__MICHOPLAY_PROGRESS__%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress._percent)s|%(progress.filename)s")
    if (playerClients != null) request.addOption("--extractor-args", "youtube:player_client=$playerClients")
    if (item["isPlaylist"] == true) request.addOption("--yes-playlist") else request.addOption("--no-playlist")
    request.addOption("--playlist-end", "100")
    // The app only needs an audio stream; selecting `best` can return a
    // video+audio file that fails during MP3 conversion on some devices.
    request.addOption("-f", "bestaudio[acodec!=none]/bestaudio")
    request.addOption("-x"); request.addOption("--audio-format", "mp3"); request.addOption("--audio-quality", "0"); request.addOption("--embed-metadata")
    request.addOption("--write-subs"); request.addOption("--write-auto-subs"); request.addOption("--sub-langs", "en.*"); request.addOption("--sub-format", "vtt")
    request.addOption("--embed-thumbnail")
    request.addOption("-o", File(staging, "%(title).160B [%(id)s].%(ext)s").absolutePath)
    val downloadProgress = Regex("\\[download\\]\\s*([0-9]+(?:\\.[0-9]+)?)%")
    val sizeProgress = Regex("of\\s+~?\\s*([0-9]+(?:\\.[0-9]+)?)\\s*(KiB|MiB|GiB|KB|MB|GB|B)", RegexOption.IGNORE_CASE)
    val speedProgress = Regex("at\\s+([0-9]+(?:\\.[0-9]+)?)\\s*(KiB|MiB|GiB|KB|MB|GB|B)/s", RegexOption.IGNORE_CASE)
    val etaProgress = Regex("ETA\\s+(\\d{1,2}:\\d{2}(?::\\d{2})?)")
    val playlistItem = Regex("Downloading item\\s+(\\d+)\\s+of\\s+(\\d+)")
    var playlistPosition: Pair<Int, Int>? = null
    var isAudioTransfer = false
    YoutubeDL.getInstance().execute(request, item["id"] as String) { progress, _, line ->
      if (jobIsActive(item, generation)) {
        playlistItem.find(line)?.let { match ->
          val current = match.groupValues[1].toIntOrNull()
          val total = match.groupValues[2].toIntOrNull()
          if (current != null && total != null && total > 0) playlistPosition = current to total
        }
        val destination = Regex("^\\[download\\] Destination:\\s*(.+)$").find(line)?.groupValues?.get(1)?.trim()
        if (destination != null) {
          val extension = destination.substringAfterLast('.', "").substringBefore('?').lowercase()
          isAudioTransfer = extension in setOf("webm", "m4a", "mp3", "opus", "ogg", "aac", "flac", "wav")
          if (isAudioTransfer) { item["phase"] = "downloading"; item["message"] = "Downloading audio…"; emitDownloads() }
          else if (extension == "vtt") { item["phase"] = "lyrics"; item["message"] = "Fetching synced lyrics…"; emitDownloads() }
        }
        when {
          line.startsWith("[youtube]") -> { item["phase"] = "fetching"; item["message"] = "Getting song information…"; emitDownloads() }
          "[ExtractAudio]" in line -> { item["phase"] = "processing"; item["message"] = "Processing audio…"; emitDownloads() }
          "[Metadata]" in line || "[EmbedThumbnail]" in line -> { item["phase"] = "metadata"; item["message"] = "Adding artwork and song information…"; emitDownloads() }
        }
        val progressMatch = downloadProgress.find(line)
        val template = line.substringAfter("__MICHOPLAY_PROGRESS__", "").takeIf { it != line && it.isNotEmpty() }
        val fields = template?.split('|')
        val progressExtension = fields?.getOrNull(7)?.substringAfterLast('.', "")?.substringBefore('?')?.lowercase()
        val progressIsAudio = progressExtension in setOf("webm", "m4a", "mp3", "opus", "ogg", "aac", "flac", "wav")
        val percentValue = fields?.getOrNull(0)?.trim()?.removeSuffix("%")?.toDoubleOrNull()
          ?: fields?.getOrNull(6)?.trim()?.toDoubleOrNull()
          ?: progressMatch?.groupValues?.getOrNull(1)?.toDoubleOrNull()
          ?: progress.takeIf { it.isFinite() }?.toDouble()
        if (percentValue != null && (isAudioTransfer || progressIsAudio)) {
          // Ignore caption/artwork transfers so the bar follows the audio stream.
          val trackPercent = percentValue.coerceIn(0.0, 100.0)
          val position = playlistPosition
          val reportedPercent = if (item["isPlaylist"] == true && position != null) {
            (((position.first - 1) + trackPercent / 100.0) / position.second * 100.0).coerceIn(0.0, 100.0)
          } else trackPercent
          val percent = maxOf(reportedPercent, (item["percent"] as? Number)?.toDouble() ?: 0.0)
          item["percent"] = percent
          val totalMatch = sizeProgress.find(line)
          val actualTotal = fields?.getOrNull(2)?.toLongOrNull()
          val estimatedTotal = fields?.getOrNull(3)?.toLongOrNull()
          val totalBytes = actualTotal ?: estimatedTotal
            ?: totalMatch?.let { toByteCount(it.groupValues[1], it.groupValues[2]) }
          val estimated = actualTotal == null && (estimatedTotal != null || (fields == null && line.contains("of ~")))
          val previousTotal = (item["totalBytes"] as? Number)?.toLong() ?: 0L
          if (item["isPlaylist"] == true) {
            item["downloadedBytes"] = null; item["totalBytes"] = null
            item["message"] = position?.let { "Track ${it.first} of ${it.second} · ${trackPercent.toInt()}% of this track" } ?: "Downloading audio…"
          } else {
            if (totalBytes != null && totalBytes >= previousTotal) {
              item["totalBytes"] = totalBytes
              item["totalBytesEstimated"] = estimated
            }
            val estimate = fields?.getOrNull(1)?.toLongOrNull() ?: (totalBytes?.let { (it * trackPercent / 100.0).toLong() } ?: 0L)
            val previousDownloaded = (item["downloadedBytes"] as? Number)?.toLong() ?: 0L
            item["downloadedBytes"] = maxOf(previousDownloaded, estimate).let { value -> if (estimated || totalBytes == null) value else value.coerceAtMost(totalBytes) }
          }
          item["speedBytesPerSecond"] = fields?.getOrNull(4)?.toDoubleOrNull()?.toLong()
            ?: speedProgress.find(line)?.let { toByteCount(it.groupValues[1], it.groupValues[2]) }
          item["etaSeconds"] = fields?.getOrNull(5)?.toLongOrNull() ?: etaProgress.find(line)?.groupValues?.getOrNull(1)?.let(::parseEtaSeconds)
          if (item["isPlaylist"] != true) item["message"] = line.substringAfter("[download]").trim()
          emitDownloads()
        }
      }
      kotlin.Unit
    }
  }

  /** Add/update the ID3 USLT frame while the MP3 is still in app-private storage. */
  private fun embedLyricsInMp3(audio: File, lyrics: String): Boolean {
    return try {
      val original = audio.readBytes()
      var version = 3
      var tagFlags = 0
      var audioOffset = 0
      val frames = ByteArrayOutputStream()
      if (original.size >= 10 && original.copyOfRange(0, 3).contentEquals(byteArrayOf(0x49, 0x44, 0x33))) {
        version = original[3].toInt() and 0xff
        tagFlags = original[5].toInt() and 0xff
        if (version !in 3..4 || tagFlags and 0x80 != 0 || (version == 4 && tagFlags and 0x10 != 0)) return false
        val tagLength = readSynchsafeInt(original, 6)
        audioOffset = 10 + tagLength
        if (audioOffset > original.size) return false
        val bodyStart = when {
          tagFlags and 0x40 == 0 -> 10
          version == 3 -> 10 + 4 + readBigEndianInt(original, 10)
          else -> 10 + readSynchsafeInt(original, 10)
        }
        if (bodyStart > audioOffset) return false
        var cursor = bodyStart
        while (cursor + 10 <= audioOffset) {
          if (original[cursor] == 0.toByte()) break // ID3 padding
          val id = String(original, cursor, 4, Charsets.ISO_8859_1)
          if (!id.matches(Regex("[A-Z0-9]{4}"))) return false
          val frameLength = if (version == 4) readSynchsafeInt(original, cursor + 4) else readBigEndianInt(original, cursor + 4)
          val frameEnd = cursor + 10 + frameLength
          if (frameLength < 0 || frameEnd > audioOffset) return false
          if (id != "USLT") frames.write(original, cursor, frameEnd - cursor)
          cursor = frameEnd
        }
        // The extended header was intentionally removed; its flag must not remain set.
        tagFlags = tagFlags and 0x40.inv()
      }

      val lyricFrameBody = ByteArrayOutputStream().apply {
        write(1) // UTF-16 with BOM, supported by ID3v2.3 and v2.4.
        write(byteArrayOf(0x65, 0x6e, 0x67)) // English
        write(byteArrayOf(0xff.toByte(), 0xfe.toByte(), 0x00, 0x00)) // Empty UTF-16 descriptor.
        write(lyrics.toByteArray(Charset.forName("UTF-16")))
      }.toByteArray()
      DataOutputStream(frames).use { out ->
        out.writeBytes("USLT")
        if (version == 4) writeSynchsafeInt(out, lyricFrameBody.size) else out.writeInt(lyricFrameBody.size)
        out.writeShort(0)
        out.write(lyricFrameBody)
      }
      val newBody = frames.toByteArray()
      val temp = File(audio.parentFile, audio.name + ".lyrics-tmp")
      DataOutputStream(temp.outputStream().buffered()).use { out ->
        out.writeBytes("ID3")
        out.writeByte(version)
        out.writeByte(0)
        out.writeByte(tagFlags)
        writeSynchsafeInt(out, newBody.size)
        out.write(newBody)
        out.write(original, audioOffset, original.size - audioOffset)
      }
      if (temp.length() <= 10L) { temp.delete(); return false }
      val backup = File(audio.parentFile, audio.name + ".lyrics-backup")
      if (backup.exists()) backup.delete()
      if (!audio.renameTo(backup)) { temp.delete(); return false }
      if (!temp.renameTo(audio)) {
        backup.renameTo(audio)
        temp.delete()
        return false
      }
      backup.delete()
      true
    } catch (_: Exception) {
      false
    }
  }

  private fun readBigEndianInt(bytes: ByteArray, offset: Int): Int {
    if (offset + 4 > bytes.size) throw IOException("Incomplete ID3 frame size")
    return ((bytes[offset].toInt() and 0xff) shl 24) or ((bytes[offset + 1].toInt() and 0xff) shl 16) or
      ((bytes[offset + 2].toInt() and 0xff) shl 8) or (bytes[offset + 3].toInt() and 0xff)
  }

  private fun readSynchsafeInt(bytes: ByteArray, offset: Int): Int {
    if (offset + 4 > bytes.size) throw IOException("Incomplete ID3 size")
    val a = bytes[offset].toInt() and 0xff; val b = bytes[offset + 1].toInt() and 0xff
    val c = bytes[offset + 2].toInt() and 0xff; val d = bytes[offset + 3].toInt() and 0xff
    if ((a or b or c or d) and 0x80 != 0) throw IOException("Invalid ID3 synchsafe size")
    return (a shl 21) or (b shl 14) or (c shl 7) or d
  }

  private fun writeSynchsafeInt(out: DataOutputStream, value: Int) {
    if (value < 0 || value > 0x0fffffff) throw IOException("ID3 tag is too large")
    out.writeByte((value shr 21) and 0x7f); out.writeByte((value shr 14) and 0x7f)
    out.writeByte((value shr 7) and 0x7f); out.writeByte(value and 0x7f)
  }

  private fun vttToLrc(vtt: String): String {
    val lines = mutableListOf<String>()
    val cue = mutableListOf<String>()
    var startMs: Long? = null
    fun flush() {
      val start = startMs
      val text = cue.joinToString(" ").replace(Regex("<[^>]*>"), "")
        .replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
        .replace("&quot;", "\"").replace("&#39;", "'").replace("&nbsp;", " ")
        .trim().split(Regex("\\s+")).joinToString(" ").trim()
      cue.clear()
      if (start != null && text.isNotEmpty() && lines.lastOrNull()?.substringAfter(']') != text) {
        val minutes = (start / 60000).toString().padStart(2, '0')
        val seconds = (start / 1000 % 60).toString().padStart(2, '0')
        val centiseconds = (start % 1000 / 10).toString().padStart(2, '0')
        lines.add("[$minutes:$seconds.$centiseconds]$text")
      }
    }
    for (row in vtt.lineSequence() + sequenceOf("")) {
      val line = row.trim()
      if ("-->" in line) {
        flush()
        startMs = vttTimestampMs(line.substringBefore("-->"))
      } else if (line.isEmpty()) {
        flush()
        startMs = null
      } else if (startMs != null) cue.add(line)
    }
    return if (lines.isEmpty()) "" else lines.joinToString("\n", postfix = "\n")
  }

  private fun vttTimestampMs(value: String): Long? {
    val parts = value.trim().split('.')
    if (parts.size != 2) return null
    val time = parts[0].split(':').map { it.toLongOrNull() ?: return null }
    val seconds = when (time.size) {
      2 -> time[0] * 60 + time[1]
      3 -> time[0] * 3600 + time[1] * 60 + time[2]
      else -> return null
    }
    val millis = parts[1].take(3).padEnd(3, '0').toLongOrNull() ?: return null
    return seconds * 1000 + millis
  }

  private fun isYoutubeCompatibilityFailure(error: Throwable): Boolean {
    var cause: Throwable? = error
    while (cause != null) {
      val message = cause.message.orEmpty()
      if (message.contains("403") || message.contains("forbidden", ignoreCase = true) ||
        message.contains("signature", ignoreCase = true) ||
        message.contains("challenge", ignoreCase = true) ||
        message.contains("javascript runtime", ignoreCase = true) ||
        message.contains("no video formats", ignoreCase = true) ||
        message.contains("requested format", ignoreCase = true)) return true
      cause = cause.cause
    }
    return false
  }

  @Synchronized
  private fun refreshDownloaderForCompatibility(): Boolean {
    if (downloader403RefreshAttempted) return false
    downloader403RefreshAttempted = true
    return try {
      YoutubeDL.getInstance().updateYoutubeDL(activity.applicationContext, YoutubeDL.UpdateChannel.NIGHTLY)
      downloaderError = null
      true
    } catch (error: Exception) {
      downloaderError = error.message ?: "YouTube support could not be refreshed."
      false
    }
  }

  private data class PublishedAudio(val path: String, val uri: Uri?, val created: Boolean)

  private fun jobIsActive(item: Map<String, Any?>, generation: Int): Boolean =
    item["status"] == "downloading" && jobGenerations[item["id"] as? String]?.get() == generation

  private fun requireActiveJob(item: Map<String, Any?>, generation: Int) {
    if (!jobIsActive(item, generation)) throw IllegalStateException("The download was stopped.")
  }

  private fun requirePlayableAudio(file: File) {
    if (!file.isFile || file.length() == 0L) throw IllegalStateException("The downloaded audio couldn't be read.")
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(file.absolutePath)
      if ((retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L) <= 0L)
        throw IllegalStateException("The downloaded audio couldn't be read.")
    } catch (error: Exception) {
      throw IllegalStateException("The downloaded audio couldn't be read.", error)
    } finally { retriever.release() }
  }

  private fun requirePlayableAudio(uri: Uri) {
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(activity, uri)
      if ((retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L) <= 0L)
        throw IllegalStateException("The saved audio couldn't be read.")
    } catch (error: Exception) {
      throw IllegalStateException("The saved audio couldn't be read.", error)
    } finally { retriever.release() }
  }

  @Synchronized private fun emitDownloads(force: Boolean = false) {
    val now = android.os.SystemClock.elapsedRealtime()
    val states = downloads.joinToString("|") { "${it["id"]}:${it["status"]}:${it["phase"]}" }
    val changed = states != lastDownloadStates
    if (!force && !changed && now - lastDownloadUpdateMs < 250L) return
    lastDownloadUpdateMs = now
    lastDownloadStates = states
    val snapshot = JSONArray().apply { downloads.forEach { item -> put(JSONObject(synchronized(item) { item.toMap() })) } }
    runCatching { trigger("youtube-downloads-updated", JSObject().apply { put("items", snapshot) }) }
    if (force || changed || now - lastDownloadPersistMs >= 1000L) {
      lastDownloadPersistMs = now
      val editor = activity.getSharedPreferences("michoplay_downloads", Activity.MODE_PRIVATE)
        .edit().putString("jobs", snapshot.toString())
      if (force || changed) editor.commit() else editor.apply()
    }
  }

  private fun restoreDownloads() {
    val raw = activity.getSharedPreferences("michoplay_downloads", Activity.MODE_PRIVATE).getString("jobs", null) ?: return
    val saved = runCatching { JSONArray(raw) }.getOrNull() ?: return
    for (index in 0 until saved.length()) {
      val entry = saved.optJSONObject(index) ?: continue
      val id = entry.optString("id")
      val url = entry.optString("url")
      if (id.isBlank() || url.isBlank()) continue
      val item = Collections.synchronizedMap(mutableMapOf<String, Any?>())
      for (key in listOf("id", "title", "url", "thumbnail", "isPlaylist", "playlist", "status", "phase", "percent", "downloadedBytes", "totalBytes", "totalBytesEstimated", "speedBytesPerSecond", "etaSeconds", "message")) {
        item[key] = entry.opt(key).takeUnless { it == JSONObject.NULL }
      }
      item["filePaths"] = entry.optJSONArray("filePaths")?.let { array -> (0 until array.length()).mapNotNull { array.optString(it).takeIf(String::isNotBlank) } } ?: emptyList<String>()
      if (item["status"] == "downloading") {
        item["status"] = "queued"; item["phase"] = "queued"; item["message"] = "Resuming interrupted download…"
      }
      downloads.add(item)
      jobGenerations[id] = AtomicInteger(0)
      nextDownloadId.updateAndGet { current -> maxOf(current, (id.removePrefix("youtube-").toIntOrNull() ?: 0) + 1) }
    }
    emitDownloads(true)
  }

  private fun toByteCount(value: String, unit: String): Long {
    val base = if (unit.endsWith("iB")) 1024.0 else 1000.0
    val power = when (unit) { "KiB", "KB" -> 1.0; "MiB", "MB" -> 2.0; "GiB", "GB" -> 3.0; else -> 0.0 }
    return ((value.toDoubleOrNull() ?: 0.0) * Math.pow(base, power)).toLong()
  }

  private fun parseEtaSeconds(value: String): Long? {
    val parts = value.split(':').mapNotNull(String::toLongOrNull)
    if (parts.size !in 2..3) return null
    return if (parts.size == 3) parts[0] * 3600 + parts[1] * 60 + parts[2] else parts[0] * 60 + parts[1]
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

  private fun copyAudioToOutput(file: File, output: java.io.OutputStream, item: Map<String, Any?>, generation: Int) {
    file.inputStream().use { input ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        requireActiveJob(item, generation)
        val count = input.read(buffer)
        if (count < 0) break
        output.write(buffer, 0, count)
      }
    }
    requireActiveJob(item, generation)
  }

  private fun publishAudioToMusic(file: File, item: Map<String, Any?>, generation: Int): PublishedAudio {
    val playlist = item["playlist"] as? Map<*, *>
    val playlistTitle = playlist?.get("title") as? String
    val playlistFolder = if (playlistTitle != null || item["isPlaylist"] == true) safePlaylistFolderName(playlistTitle ?: item["title"] as? String) else null
    val folder = buildString {
      append("MichoPlay")
      if (playlistFolder != null) append("/").append(playlistFolder)
    }
    val destination = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), "$folder/${file.name}")
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      val directory = destination.parentFile ?: throw IllegalStateException("Android couldn’t create the playlist folder.")
      if (!directory.exists() && !directory.mkdirs()) throw IllegalStateException("Android couldn’t create the playlist folder in Music/MichoPlay.")
      if (destination.exists() && runCatching { requirePlayableAudio(destination) }.isSuccess)
        return PublishedAudio(destination.absolutePath, null, false)
      val created = !destination.exists() || destination.delete()
      try {
        destination.outputStream().use { output -> copyAudioToOutput(file, output, item, generation) }
        requirePlayableAudio(destination)
        return PublishedAudio(destination.absolutePath, null, created)
      } catch (error: Exception) {
        if (created) destination.delete()
        throw error
      }
    }
    val relativePath = "${Environment.DIRECTORY_MUSIC}/$folder/"
    val collection = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
    activity.contentResolver.query(collection, arrayOf(MediaStore.Audio.Media._ID, MediaStore.Audio.Media.DATA),
      "${MediaStore.Audio.Media.DISPLAY_NAME}=? AND ${MediaStore.Audio.Media.RELATIVE_PATH}=?",
      arrayOf(file.name, relativePath), null)?.use { cursor ->
      while (cursor.moveToNext()) {
        val existing = ContentUris.withAppendedId(collection, cursor.getLong(0))
        if (runCatching { requirePlayableAudio(existing) }.isSuccess) {
          val path = cursor.getString(1) ?: destination.absolutePath
          return PublishedAudio(path, existing, false)
        }
      }
    }
    val values = ContentValues().apply {
      put(MediaStore.Audio.Media.DISPLAY_NAME, file.name)
      put(MediaStore.Audio.Media.TITLE, file.nameWithoutExtension)
      put(MediaStore.Audio.Media.MIME_TYPE, "audio/mpeg")
      put(MediaStore.Audio.Media.RELATIVE_PATH, relativePath)
      put(MediaStore.Audio.Media.IS_PENDING, 1)
    }
    val uri = activity.contentResolver.insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, values)
      ?: throw IllegalStateException("Android couldn’t create a file in the Music folder.")
    try {
      activity.contentResolver.openOutputStream(uri, "w")?.use { output -> copyAudioToOutput(file, output, item, generation) }
        ?: throw IllegalStateException("Android couldn’t open the new Music file.")
      requireActiveJob(item, generation)
      ContentValues().apply { put(MediaStore.Audio.Media.IS_PENDING, 0) }.also { activity.contentResolver.update(uri, it, null, null) }
      requirePlayableAudio(uri)
      val storedPath = runCatching {
        activity.contentResolver.query(uri, arrayOf(MediaStore.Audio.Media.DATA), null, null, null)?.use { cursor ->
          val column = cursor.getColumnIndex(MediaStore.Audio.Media.DATA)
          if (column >= 0 && cursor.moveToFirst()) cursor.getString(column) else null
        }
      }.getOrNull()
      return PublishedAudio(storedPath ?: destination.absolutePath, uri, true)
    } catch (error: Exception) {
      activity.contentResolver.delete(uri, null, null)
      throw error
    }
  }

  private fun safePlaylistFolderName(title: String?): String {
    val cleaned = (title ?: "")
      .map { character -> if (character.isISOControl() || character in "\\/:*?\"<>|") '_' else character }
      .take(120)
      .joinToString("")
      .trim()
      .trim('.')
    if (cleaned.isEmpty() || cleaned == "." || cleaned == "..") return "Playlist"
    return if (cleaned.uppercase() in setOf("CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9")) "_$cleaned" else cleaned
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
    val removed = downloads.removeAll { it["id"] == id && it["status"] != "downloading" }
    if (removed) jobGenerations.remove(id)
    emitDownloads(true); invoke.resolve()
  }
  private fun changeDownload(invoke: Invoke, status: String, stop: Boolean) {
    val id = invoke.parseArgs(YoutubeDownloadArgs::class.java).id
    val item = downloads.firstOrNull { it["id"] == id } ?: run { invoke.reject("Download was not found."); return }
    val changed = synchronized(item) {
      val current = item["status"]
      val allowed = when (status) {
        "queued" -> current == "paused" || current == "failed"
        "paused" -> current == "queued" || current == "downloading"
        else -> current != "completed" && current != "cancelled"
      }
      if (allowed) {
        jobGenerations.getOrPut(id) { AtomicInteger(0) }.incrementAndGet()
        item["status"] = status
        if (status == "queued") { item["phase"] = "queued"; item["message"] = "Waiting to resume" }
        else if (stop) { item["phase"] = status; item["message"] = if (status == "paused") "Paused" else "Cancelled" }
      }
      allowed
    }
    if (!changed) { invoke.resolve(); return }
    emitDownloads(true)
    invoke.resolve()
    if (status == "queued") io.execute { startQueuedDownloads() }
    else if (stop) io.execute { try { YoutubeDL.getInstance().destroyProcessById(id) } catch (_: Exception) {} }
  }

  @Command
  fun requestAudioFocus(invoke: Invoke) {
    activity.runOnUiThread {
      try {
        MediaPlaybackService.requestFocus(activity) { granted, generation ->
          invoke.resolve(JSObject().apply { put("granted", granted); put("generation", generation) })
        }
      } catch (error: Exception) {
        android.util.Log.e("MichoPlayMedia", "Could not acquire audio focus", error)
        invoke.reject(error.message ?: "Could not acquire audio focus.")
      }
    }
  }

  @Command
  fun update(invoke: Invoke) {
    activity.runOnUiThread {
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
          ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
          !notificationPermissionPrompted) {
          notificationPermissionPrompted = true
          activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 9043)
        }
        MediaPlaybackService.publish(invoke.parseArgs(MediaUpdateArgs::class.java))
        invoke.resolve()
      } catch (error: Exception) {
        android.util.Log.e("MichoPlayMedia", "Could not update playback notification", error)
        invoke.reject(error.message ?: "Could not update Android playback controls.")
      }
    }
  }

  @Command
  fun stop(invoke: Invoke) {
    activity.runOnUiThread {
      MediaPlaybackService.stopFromPlayer(activity)
      invoke.resolve()
    }
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
