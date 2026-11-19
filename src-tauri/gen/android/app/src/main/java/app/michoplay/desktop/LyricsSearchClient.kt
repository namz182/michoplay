package app.michoplay.desktop

import java.net.HttpURLConnection
import java.net.URL

object LyricsSearchClient {
  data class Response(val status: Int, val retryAfter: String?, val body: String)

  fun fetch(requestUrl: String): Response {
    val url = URL(requestUrl)
    require(url.protocol == "https" && url.host == "lrclib.net" && url.port in listOf(-1, 443) && url.userInfo == null && url.path == "/api/search") {
      "Invalid lyrics search request."
    }
    val connection = url.openConnection() as HttpURLConnection
    connection.requestMethod = "GET"
    connection.connectTimeout = 8_000
    connection.readTimeout = 10_000
    connection.instanceFollowRedirects = false
    connection.setRequestProperty("User-Agent", "MichoPlay Android")
    connection.setRequestProperty("Accept", "application/json")
    try {
      val status = connection.responseCode
      val stream = if (status in 200..299) connection.inputStream else connection.errorStream
      val body = stream?.use { input ->
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        var total = 0
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          total += count
          require(total <= 2_000_000) { "The lyrics search response was too large." }
          output.write(buffer, 0, count)
        }
        output.toString(Charsets.UTF_8.name())
      } ?: ""
      return Response(status, connection.getHeaderField("Retry-After"), body)
    } finally {
      connection.disconnect()
    }
  }
}
