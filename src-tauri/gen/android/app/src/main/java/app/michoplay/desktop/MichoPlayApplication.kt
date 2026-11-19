package app.michoplay.desktop

import android.app.Application
import com.google.android.material.color.DynamicColors

class MichoPlayApplication : Application() {
  override fun onCreate() {
    super.onCreate()
    DynamicColors.applyToActivitiesIfAvailable(this)
  }
}
