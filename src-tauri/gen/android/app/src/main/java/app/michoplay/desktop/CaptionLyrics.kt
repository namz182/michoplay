package app.michoplay.desktop

// Keep behavior in sync with src/captions.rs; both use fixtures/captions.json.
internal object CaptionLyrics {
  private data class Word(val text: String, val time: Long)
  private data class Cue(val start: Long, val end: Long, val words: List<Word>)
  private data class Line(val start: Long, var end: Long, var text: String)

  private fun timestampMs(value: String): Long? {
    val parts = value.trim().split('.')
    if (parts.size != 2 || parts[1].length != 3 || !parts[1].all { it in '0'..'9' }) return null
    val time = parts[0].split(':')
    if (time.size !in 2..3 || time.any { it.length < 2 || !it.all { c -> c in '0'..'9' } }) return null
    val seconds = time.last().toLongOrNull() ?: return null
    val minutes = time[time.size - 2].toLongOrNull() ?: return null
    val hours = if (time.size == 3) time[0].toLongOrNull() ?: return null else 0L
    if (seconds >= 60 || (time.size == 3 && minutes >= 60)) return null
    return try {
      Math.addExact(Math.addExact(Math.addExact(Math.multiplyExact(hours, 3600000L), Math.multiplyExact(minutes, 60000L)), seconds * 1000), parts[1].toLong())
    } catch (_: ArithmeticException) { null }
  }

  private val entities = Regex("&(#x[0-9a-fA-F]+|#X[0-9a-fA-F]+|#[0-9]+|[a-z]+);")
  private fun decodeEntities(text: String): String = entities.replace(text) { match ->
    val entity = match.groupValues[1]
    when (entity) {
      "amp" -> "&"; "lt" -> "<"; "gt" -> ">"; "quot" -> "\""; "apos", "#39" -> "'"
      "nbsp" -> " "; "lrm" -> "\u200e"; "rlm" -> "\u200f"
      else -> {
        val code = if (entity.startsWith("#x", true)) entity.drop(2).toIntOrNull(16) else entity.removePrefix("#").toIntOrNull()
        if (code != null && Character.isValidCodePoint(code) && code !in 0xD800..0xDFFF) String(Character.toChars(code)) else match.value
      }
    }
  }

  private fun words(payload: String, start: Long, end: Long): List<Word> {
    val result = mutableListOf<Word>()
    val word = StringBuilder()
    var time = start
    var wordTime = start
    var index = 0
    fun flush() {
      if (word.isNotEmpty()) {
        result.add(Word(decodeEntities(word.toString()), wordTime))
        word.clear()
      }
    }
    while (index < payload.length) {
      if (payload[index] == '<') {
        val close = payload.indexOf('>', index + 1)
        if (close >= 0) {
          val next = timestampMs(payload.substring(index + 1, close))
          if (next != null && next >= time && next < end) time = next
          index = close + 1
          continue
        }
      }
      val c = payload[index++]
      if (c.isWhitespace()) flush() else {
        if (word.isEmpty()) wordTime = time
        word.append(c)
      }
    }
    flush()
    return result
  }

  private fun stamp(time: Long): String = "[${(time / 60000).toString().padStart(2, '0')}:${(time / 1000 % 60).toString().padStart(2, '0')}.${(time % 1000).toString().padStart(3, '0')}]"

  fun fromVtt(vtt: String): String {
    if (vtt.length > 2000000 || !vtt.removePrefix("\uFEFF").startsWith("WEBVTT")) return ""
    val normalized = vtt.replace("\r\n", "\n").replace('\r', '\n').lineSequence().map { it.trim() }.joinToString("\n")
    val cues = mutableListOf<Cue>()
    for (block in normalized.split("\n\n")) {
      val rows = block.lines()
      if (rows.firstOrNull()?.startsWith("NOTE") == true || rows.firstOrNull() in listOf("STYLE", "REGION")) continue
      val index = rows.indexOfFirst { "-->" in it }
      if (index < 0) continue
      val timing = rows[index].split("-->", limit = 2)
      val start = timestampMs(timing[0]) ?: continue
      val end = timestampMs(timing[1].trim().substringBefore(' ')) ?: continue
      if (end <= start) continue
      val words = words(rows.drop(index + 1).joinToString(" "), start, end)
      if (words.isNotEmpty()) cues.add(Cue(start, end, words))
    }
    val lines = mutableListOf<Line>()
    val rolling = cues.any { cue -> cue.words.any { it.time > cue.start } }
    var previous: Cue? = null
    for (cue in cues.sortedBy { it.start }) {
      val prior = previous
      val overlap = if (prior != null && (cue.start < prior.end || (rolling && cue.start <= prior.end + 50))) {
        (minOf(prior.words.size, cue.words.size) downTo 1).firstOrNull { size ->
          (size >= 2 || size == cue.words.size) && cue.words.take(size).all { it.time == cue.start } && prior.words.takeLast(size).map { it.text } == cue.words.take(size).map { it.text }
        } ?: 0
      } else 0
      if (overlap > 0) lines.lastOrNull()?.let { it.end = maxOf(it.end, cue.end) }
      val fresh = cue.words.drop(overlap)
      if (fresh.isNotEmpty()) {
        val text = fresh.joinToString(" ") { it.text }
        val last = lines.lastOrNull()
        if (last != null && last.start == fresh.first().time) { last.text += " $text"; last.end = maxOf(last.end, cue.end) }
        else lines.add(Line(fresh.first().time, cue.end, text))
      }
      previous = cue
    }
    if (lines.isEmpty()) return ""
    lines.sortBy { it.start }
    return buildString {
      append("[re:MichoPlay YouTube captions v2]\n")
      lines.forEachIndexed { index, line ->
        append(stamp(line.start)); append(line.text); append('\n')
        if (lines.getOrNull(index + 1)?.let { it.start > line.end + 250 } != false) { append(stamp(line.end)); append('\n') }
      }
    }
  }
}
