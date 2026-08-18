package com.vortex.mesh

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    instance = this
    try {
      // Keep an application Context in Rust. Activity-only work (APK install)
      // is dispatched through the static installApk method below.
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
    if (requiredBlePermissions().all {
        ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
    }) {
      BleForegroundService.start(applicationContext)
    }
    requestBlePermissionsIfNeeded()
  }

  private fun requiredBlePermissions(): List<String> =
    if (Build.VERSION.SDK_INT >= 31) {
      listOf(
        android.Manifest.permission.BLUETOOTH_SCAN,
        android.Manifest.permission.BLUETOOTH_ADVERTISE,
        android.Manifest.permission.BLUETOOTH_CONNECT
      )
    } else {
      listOf(android.Manifest.permission.ACCESS_FINE_LOCATION)
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

    val requiredGranted = requiredBlePermissions().all {
      ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
    }
    android.util.Log.i("MainActivity", "BLE permissions granted=$requiredGranted")
    if (requiredGranted) {
      try {
        // Promote BLE to a foreground service so scanning / GATT / relay
        // continue when the UI is backgrounded or the screen turns off.
        BleForegroundService.start(applicationContext)
        // Rust owns initialization order. The frontend listener calls
        // start_mesh, which first sets the authenticated Node ID and only then
        // starts advertising. Starting here used to advertise an empty ID.
        NativeBridge.onPermissionsGranted()
      } catch (error: Throwable) {
        android.util.Log.w("MainActivity", "Permission callback failed", error)
      }
    }
  }

  override fun onResume() {
    super.onResume()
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
    try {
      BleManager.stopScanning(this)
      BleManager.stopAdvertising(this)
    } catch (error: Throwable) {
      android.util.Log.w("MainActivity", "BLE cleanup failed", error)
    }
    if (instance === this) instance = null
    super.onDestroy()
  }

  private fun installApkInternal(apkPath: String) {
    val file = File(apkPath).canonicalFile
    val cacheRoot = File(cacheDir, "updates").canonicalFile
    if (!file.isFile || !file.path.startsWith(cacheRoot.path + File.separator)) {
      throw SecurityException("APK path is outside the update cache")
    }

    if (Build.VERSION.SDK_INT >= 26 && !packageManager.canRequestPackageInstalls()) {
      val settingsIntent = Intent(
        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        Uri.parse("package:$packageName")
      ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      startActivity(settingsIntent)
      throw IllegalStateException("Allow installs from this app, then retry the update")
    }

    val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
    val installIntent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, "application/vnd.android.package-archive")
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    startActivity(installIntent)
  }

  companion object {
    private const val BLE_PERMISSION_REQUEST = 4201
    @Volatile private var instance: MainActivity? = null

    @JvmStatic
    fun installApk(apkPath: String): Boolean {
      val activity = instance ?: return false
      val result = AtomicBoolean(false)
      val completed = CountDownLatch(1)
      val install = {
        try {
          activity.installApkInternal(apkPath)
          result.set(true)
        } catch (error: Throwable) {
          android.util.Log.e("MainActivity", "APK install failed", error)
          try { NativeBridge.onBleError("APK install failed: ${error.message}") } catch (_: Throwable) {}
        } finally {
          completed.countDown()
        }
      }
      if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) {
        install()
      } else {
        activity.runOnUiThread { install() }
        completed.await(5, TimeUnit.SECONDS)
      }
      return result.get()
    }
  }
}
