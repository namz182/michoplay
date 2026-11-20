package app.michoplay.desktop

import android.util.Base64
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import org.json.JSONObject

internal object SpotifyPreviewClient {
  private const val MAX_BYTES = 5000000
  private const val playlistContentsHash = "21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf"
  private val previewPath = Regex("/embed/(track|album|playlist)/[A-Za-z0-9]{22}")
  private val homePath = Regex("^/(?:intl-[A-Za-z]{2}/?)?$")

  // Android's HTTP stack uses the phone's DNS and certificate configuration.
  fun fetch(
    previewUrl: String,
    onConnection: (HttpURLConnection) -> Unit = {},
    openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
  ): String {
    var url = URL(previewUrl)
    repeat(4) { attempt ->
      require(url.protocol == "https" && url.host == "open.spotify.com" && url.port in listOf(-1, 443) && url.userInfo == null && (previewPath.matches(url.path) || homePath.matches(url.path))) { "Paste a valid Spotify song, album, or playlist link." }
      val connection = openConnection(url)
      try {
        onConnection(connection)
        connection.connectTimeout = 8000
        connection.readTimeout = 10000
        connection.instanceFollowRedirects = false
        connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36")
        connection.setRequestProperty("Accept", "text/html")
        connection.setRequestProperty("Accept-Encoding", "identity")
        val status = connection.responseCode
        if (status in listOf(301, 302, 303, 307, 308)) {
          if (attempt == 3) throw IOException("Spotify redirected too many times. Retry the link.")
          url = URL(url, connection.getHeaderField("Location") ?: throw IOException("Spotify returned an invalid preview redirect."))
        } else {
          if (status == 429) throw IOException("Spotify is busy. Wait a moment and retry.")
          if (status !in 200..299) throw IOException("Spotify could not preview this link. Check that it is public and retry.")
          if (connection.contentLengthLong > MAX_BYTES) throw IOException("Spotify’s public preview response was too large.")
          return connection.inputStream.use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
              val count = input.read(buffer)
              if (count < 0) break
              if (output.size() + count > MAX_BYTES) throw IOException("Spotify’s public preview response was too large.")
              output.write(buffer, 0, count)
            }
            output.toString("UTF-8")
          }
        }
      } finally { connection.disconnect() }
    }
    throw IOException("Spotify’s public preview could not be reached. Retry the link.")
  }

  fun loadPlaylistSongsPage(
    previewUrl: String,
    offset: Int,
    onConnection: (HttpURLConnection) -> Unit = {},
  ): String {
    require(offset in 0..100000) { "Invalid Spotify playlist page." }
    val html = fetch(previewUrl, onConnection = onConnection)
    val accessToken = Regex("\"accessToken\"\\s*:\\s*\"([^\"]+)\"")
      .find(html)
      ?.groupValues
      ?.getOrNull(1)
      ?.takeIf { it.isNotBlank() }
      ?: throw IOException("Spotify did not provide access to the next playlist page.")
    val clientId = Regex("\"clientId\"\\s*:\\s*\"([^\"]+)\"")
      .find(html)
      ?.groupValues
      ?.getOrNull(1)
      ?.takeIf { it.isNotBlank() }
    val clientVersion = if (clientId != null) {
      runCatching { clientVersionFromHtml(fetch("https://open.spotify.com/", onConnection = onConnection)) }
        .getOrNull()
    } else {
      null
    }
    val clientToken = if (clientId != null && clientVersion != null) {
      requestClientToken(clientId, clientVersion, onConnection)
    } else {
      null
    }
    val playlistId = URL(previewUrl).path.substringAfterLast('/')
    val body = JSONObject()
      .put(
        "variables",
        JSONObject()
          .put("uri", "spotify:playlist:$playlistId")
          .put("offset", offset)
          .put("limit", 100)
          .put("includeEpisodeContentRatingsV2", true),
      )
      .put("operationName", "fetchPlaylistContents")
      .put(
        "extensions",
        JSONObject().put(
          "persistedQuery",
          JSONObject().put("version", 1).put("sha256Hash", playlistContentsHash),
        ),
      )
      .toString()

    val connection = URL("https://api-partner.spotify.com/pathfinder/v2/query")
      .openConnection() as HttpURLConnection
    try {
      onConnection(connection)
      connection.connectTimeout = 8000
      connection.readTimeout = 12000
      connection.instanceFollowRedirects = false
      connection.requestMethod = "POST"
      connection.doOutput = true
      connection.setRequestProperty(
        "User-Agent",
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
      )
      connection.setRequestProperty("Accept", "application/json")
      connection.setRequestProperty("Content-Type", "application/json;charset=UTF-8")
      connection.setRequestProperty("Authorization", "Bearer $accessToken")
      connection.setRequestProperty("app-platform", "WebPlayer")
      if (clientToken != null && clientVersion != null) {
        connection.setRequestProperty("client-token", clientToken)
        connection.setRequestProperty("spotify-app-version", clientVersion)
      }
      connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
      val status = connection.responseCode
      if (status == 429) throw IOException("Spotify is busy. Wait a moment, then retry loading more songs.")
      if (status == 401 || status == 403) throw IOException("Spotify did not allow access to the next playlist page.")
      if (status !in 200..299) throw IOException("Spotify could not load more songs from this playlist.")
      if (connection.contentLengthLong > MAX_BYTES) throw IOException("Spotify’s playlist page was too large.")
      return connection.inputStream.use { input ->
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          if (output.size() + count > MAX_BYTES) throw IOException("Spotify’s playlist page was too large.")
          output.write(buffer, 0, count)
        }
        output.toString("UTF-8")
      }
    } finally {
      connection.disconnect()
    }
  }

  private fun clientVersionFromHtml(html: String): String {
    val encoded = Regex(
      "<script[^>]*id=\"appServerConfig\"[^>]*>([^<]+)</script>",
      RegexOption.IGNORE_CASE,
    ).find(html)?.groupValues?.getOrNull(1)
      ?: throw IOException("Spotify did not provide its web player version.")
    val config = JSONObject(String(Base64.decode(encoded, Base64.DEFAULT), Charsets.UTF_8))
    return config.optString("clientVersion").takeIf { it.isNotBlank() }
      ?: throw IOException("Spotify did not provide its web player version.")
  }

  private fun requestClientToken(
    clientId: String,
    clientVersion: String,
    onConnection: (HttpURLConnection) -> Unit,
  ): String? {
    val body = JSONObject()
      .put(
        "client_data",
        JSONObject()
          .put("client_version", clientVersion)
          .put("client_id", clientId)
          .put(
            "js_sdk_data",
            JSONObject()
              .put("device_brand", "unknown")
              .put("device_model", "unknown")
              .put("os", "linux")
              .put("os_version", "unknown")
              .put("device_id", UUID.randomUUID().toString())
              .put("device_type", "computer"),
          ),
      )
      .toString()
    val connection = URL("https://clienttoken.spotify.com/v1/clienttoken")
      .openConnection() as HttpURLConnection
    try {
      onConnection(connection)
      connection.connectTimeout = 8000
      connection.readTimeout = 8000
      connection.instanceFollowRedirects = false
      connection.requestMethod = "POST"
      connection.doOutput = true
      connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36")
      connection.setRequestProperty("Accept", "application/json")
      connection.setRequestProperty("Content-Type", "application/json;charset=UTF-8")
      connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
      if (connection.responseCode !in 200..299) return null
      if (connection.contentLengthLong > 1000000) return null
      val response = connection.inputStream.use { input ->
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          if (output.size() + count > 1000000) return null
          output.write(buffer, 0, count)
        }
        output.toString("UTF-8")
      }
      return JSONObject(response)
        .optJSONObject("granted_token")
        ?.optString("token")
        ?.takeIf { it.isNotBlank() }
    } catch (_: Exception) {
      return null
    } finally {
      connection.disconnect()
    }
  }
}
