package app.michoplay.desktop

import android.os.Bundle
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private var appWebView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Android 17 blocks LAN access for apps targeting API 37 unless the
    // ACCESS_LOCAL_NETWORK runtime permission is granted. Tauri's Android
    // dev proxy fetches Vite from the host machine over the local network.
    if (BuildConfig.DEBUG && Build.VERSION.SDK_INT >= 37) {
      val permission = "android.permission.ACCESS_LOCAL_NETWORK"
      if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
        requestPermissions(arrayOf(permission)) { granted ->
          if (granted == true) {
            appWebView?.reload()
          } else {
            Toast.makeText(
              this,
              "Allow local network access to load the Android development server.",
              Toast.LENGTH_LONG,
            ).show()
          }
        }
      }
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    appWebView = webView
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    MediaPlugin.dispatchOpenAudio()
  }
}
