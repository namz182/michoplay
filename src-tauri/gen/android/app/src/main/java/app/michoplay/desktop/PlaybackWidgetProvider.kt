package app.michoplay.desktop

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

class PlaybackWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    update(context, "MichoPlay", "Tap to open your music", false)
  }

  companion object {
    fun update(context: Context, title: String, artist: String, playing: Boolean) {
      val manager = AppWidgetManager.getInstance(context)
      val component = ComponentName(context, PlaybackWidgetProvider::class.java)
      val views = RemoteViews(context.packageName, R.layout.playback_widget).apply {
        setTextViewText(R.id.widget_title, title.ifBlank { "MichoPlay" })
        setTextViewText(R.id.widget_artist, artist)
        setImageViewResource(R.id.widget_play, if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play)
        setOnClickPendingIntent(R.id.widget_previous, serviceIntent(context, MediaPlaybackService.ACTION_PREVIOUS, 1))
        setOnClickPendingIntent(R.id.widget_play, serviceIntent(context, if (playing) MediaPlaybackService.ACTION_PAUSE else MediaPlaybackService.ACTION_PLAY, 2))
        setOnClickPendingIntent(R.id.widget_next, serviceIntent(context, MediaPlaybackService.ACTION_NEXT, 3))
        val launch = PendingIntent.getActivity(context, 4, Intent(context, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        setOnClickPendingIntent(R.id.widget_text, launch)
      }
      manager.updateAppWidget(component, views)
    }

    private fun serviceIntent(context: Context, action: String, request: Int): PendingIntent {
      val intent = Intent(context, MediaPlaybackService::class.java).setAction(action)
      return PendingIntent.getForegroundService(context, request, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
  }
}
