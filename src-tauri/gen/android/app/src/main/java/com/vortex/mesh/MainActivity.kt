package com.vortex.mesh

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    instance = this
    try {
      // Application Context is enough for BLE and PackageInstaller updates.
      NativeBridge.setAndroidContext(this.applicationContext)
      NativeBridge.setClassLoader(this.classLoader)
    } catch (error: Throwable) {
      android.util.Log.e("MainActivity", "NativeBridge init failed", error)
    }
    try {
      enableEdgeToEdge()
    } catch (error: Exception) {
      android.util.Log.w("MainActivity", "enableEdgeToEdge failed", error)
    }
    try {
      NfcManager.init(this)
      intent?.let(NfcManager::handleIntent)
    } catch (error: Exception) {
      android.util.Log.w("MainActivity", "NfcManager.init failed", error)
    }
    requestBlePermissionsIfNeeded()
  }

  /**
   * Wry/Tauri creates the WebView asynchronously and passes it here.
   * We forward Android's window insets (system bars, display cutout and the
   * on-screen keyboard/IME) into CSS variables so the web UI can pad its
   * safe areas. On Android `env(safe-area-inset-*)` is always 0, and with an
   * edge-to-edge window the keyboard would otherwise cover the message input.
   */
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    ViewCompat.setOnApplyWindowInsetsListener(webView) { _, windowInsets ->
      applySafeAreaInsets(webView, windowInsets)
      windowInsets
    }
    // The very first insets pass can run before the page's DOM is ready, so
    // re-apply shortly after startup to make sure the variables land on the
    // loaded document. The keyboard case is covered by the listener above,
    // which fires again whenever the IME opens or closes.
    webView.post { applySafeAreaInsets(webView, ViewCompat.getRootWindowInsets(webView)) }
    webView.postDelayed({ applySafeAreaInsets(webView, ViewCompat.getRootWindowInsets(webView)) }, 500)
  }

  private fun applySafeAreaInsets(webView: WebView, windowInsets: WindowInsetsCompat?) {
    if (windowInsets == null) return
    val safe = windowInsets.getInsets(
      WindowInsetsCompat.Type.systemBars()
        or WindowInsetsCompat.Type.displayCutout()
        or WindowInsetsCompat.Type.ime()
    )
    val density = webView.resources.displayMetrics.density
    val top = safe.top / density
    val right = safe.right / density
    val bottom = safe.bottom / density
    val left = safe.left / density
    val script = """
      (function () {
        var style = document.documentElement.style;
        style.setProperty('--safe-area-inset-top', '${top}px');
        style.setProperty('--safe-area-inset-right', '${right}px');
        style.setProperty('--safe-area-inset-bottom', '${bottom}px');
        style.setProperty('--safe-area-inset-left', '${left}px');
      })();
    """.trimIndent()
    webView.evaluateJavascript(script, null)
  }

  private fun requiredBlePermissions(): List<String> {
    val permissions = mutableListOf<String>()
    if (Build.VERSION.SDK_INT >= 31) {
      permissions += listOf(
        android.Manifest.permission.BLUETOOTH_SCAN,
        android.Manifest.permission.BLUETOOTH_ADVERTISE,
        android.Manifest.permission.BLUETOOTH_CONNECT
      )
    } else {
      permissions += android.Manifest.permission.ACCESS_FINE_LOCATION
    }
    if (Build.VERSION.SDK_INT >= 33) {
      permissions += android.Manifest.permission.POST_NOTIFICATIONS
    }
    return permissions
  }

  private fun requestBlePermissionsIfNeeded() {
    val missing = requiredBlePermissions().filter {
      ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
    }
    if (missing.isNotEmpty()) {
      ActivityCompat.requestPermissions(this, missing.toTypedArray(), BLE_PERMISSION_REQUEST)
    }
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != BLE_PERMISSION_REQUEST) return

    val requiredGranted = requiredBlePermissions().filterNot {
      it == android.Manifest.permission.POST_NOTIFICATIONS
    }.all {
      ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
    }
    android.util.Log.i("MainActivity", "BLE permissions granted=$requiredGranted")
    if (requiredGranted) {
      try {
        // Rust owns initialization order. The frontend listener calls
        // start_mesh, which first sets the authenticated Node ID and only then
        // starts advertising. Starting here used to advertise an empty ID.
        NativeBridge.onPermissionsGranted()
      } catch (error: Throwable) {
        android.util.Log.w("MainActivity", "Permission callback failed", error)
      }
    }
  }

  override fun onStart() {
    super.onStart()
    instance = this
  }

  override fun onResume() {
    super.onResume()
    instance = this
    try { BleManager.ensureForegroundService(this) } catch (_: Throwable) {}
    try {
      val pending = ApkInstaller.retryPending(this)
      if (pending == ApkInstaller.NEED_PERMISSION) {
        android.util.Log.i("MainActivity", "update waiting for install permission")
      } else if (!pending.isNullOrBlank()) {
        android.util.Log.w("MainActivity", "pending update retry: $pending")
      }
    } catch (error: Throwable) {
      android.util.Log.w("MainActivity", "pending update retry failed", error)
    }
    NfcManager.enableForegroundDispatch(this)
  }

  override fun onPause() {
    NfcManager.disableForegroundDispatch(this)
    super.onPause()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    NfcManager.handleIntent(intent)
  }

  override fun onDestroy() {
    // BLE is owned by MeshForegroundService so Activity teardown must not
    // tear down scan/advertise/GATT. That is what killed background delivery.
    if (instance === this) instance = null
    super.onDestroy()
  }

  companion object {
    private const val BLE_PERMISSION_REQUEST = 4201
    @Volatile private var instance: MainActivity? = null
  }
}
