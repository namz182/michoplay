package app.michoplay.desktop

import java.io.ByteArrayInputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

private const val previewUrl = "https://open.spotify.com/embed/playlist/3bCxmOtEZMXln987Zns5Oq"

private class PreviewConnection(
  private val status: Int = 200,
  private val body: ByteArray = "<html>Preview</html>".toByteArray(),
  private val location: String? = null,
  private val declaredLength: Long = body.size.toLong(),
) : HttpURLConnection(URL(previewUrl)) {
  var disconnected = false
  override fun connect() {}
  override fun disconnect() { disconnected = true }
  override fun usingProxy() = false
  override fun getResponseCode() = status
  override fun getContentLengthLong() = declaredLength
  override fun getInputStream() = ByteArrayInputStream(body)
  override fun getHeaderField(name: String) = if (name == "Location") location else null
}

fun main() {
  val success = PreviewConnection()
  check(SpotifyPreviewClient.fetch(previewUrl, openConnection = { success }) == "<html>Preview</html>")
  check(success.disconnected && success.connectTimeout == 8000 && success.readTimeout == 10000)
  check(!success.instanceFollowRedirects)

  val busy = PreviewConnection(status = 429)
  check(runCatching { SpotifyPreviewClient.fetch(previewUrl, openConnection = { busy }) }.exceptionOrNull()?.message?.contains("busy") == true)
  check(busy.disconnected)

  for (declaredLength in listOf(5000001L, -1L)) {
    val oversized = PreviewConnection(body = ByteArray(5000001), declaredLength = declaredLength)
    check(runCatching { SpotifyPreviewClient.fetch(previewUrl, openConnection = { oversized }) }.exceptionOrNull()?.message?.contains("too large") == true)
    check(oversized.disconnected)
  }

  var opened = 0
  val external = PreviewConnection(status = 302, location = "https://other.example/preview")
  check(runCatching { SpotifyPreviewClient.fetch(previewUrl, openConnection = { opened++; external }) }.isFailure)
  check(opened == 1 && external.disconnected)

  opened = 0
  check(runCatching { SpotifyPreviewClient.fetch(previewUrl, openConnection = { opened++; PreviewConnection(status = 302, location = previewUrl) }) }.exceptionOrNull()?.message?.contains("too many") == true)
  check(opened == 4)

  for (url in listOf("http://open.spotify.com/embed/playlist/3bCxmOtEZMXln987Zns5Oq", "https://user@open.spotify.com/embed/playlist/3bCxmOtEZMXln987Zns5Oq", "https://open.spotify.com/embed/artist/3bCxmOtEZMXln987Zns5Oq")) {
    check(runCatching { SpotifyPreviewClient.fetch(url, openConnection = { error("Invalid URLs must never connect") }) }.exceptionOrNull() is IllegalArgumentException)
  }

  check(runCatching { SpotifyPreviewClient.fetch(previewUrl, openConnection = { throw IOException("Network unavailable") }) }.exceptionOrNull()?.message == "Network unavailable")
  println("Android Spotify fetch checks passed: success, timeouts, size limits, redirects, validation, and network errors.")
}
