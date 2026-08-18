package com.vortex.mesh

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

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
