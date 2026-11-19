package app.michoplay.desktop

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

internal object SpotifyPreviewClient {
  private const val MAX_BYTES = 5000000
  private val previewPath = Regex("/embed/(track|album|playlist)/[A-Za-z0-9]{22}")

  // Android's HTTP stack uses the phone's DNS and certificate configuration.
  fun fetch(
    previewUrl: String,
    onConnection: (HttpURLConnection) -> Unit = {},
    openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
  ): String {
    var url = URL(previewUrl)
    repeat(4) { attempt ->
      require(url.protocol == "https" && url.host == "open.spotify.com" && url.port in listOf(-1, 443) && url.userInfo == null && previewPath.matches(url.path)) { "Paste a valid Spotify song, album, or playlist link." }
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
}
