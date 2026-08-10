package com.vortex.mesh

import android.os.Bundle
import android.os.Build
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import android.content.pm.PackageManager

import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.File

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    try {
      NativeBridge.setAndroidContext(this.applicationContext)
      NativeBridge.setClassLoader(this.classLoader)
    } catch (e: Throwable) {
      android.util.Log.e("MainActivity", "NativeBridge init failed in onCreate: ${e.message}")
    }
    try {
      enableEdgeToEdge()
    } catch (e: Exception) {
      android.util.Log.w("MainActivity", "enableEdgeToEdge failed: ${e.message}")
    }
    instance = this
    try {
      NfcManager.init(this)
    } catch (e: Exception) {
      android.util.Log.w("MainActivity", "NfcManager.init failed: ${e.message}")
    }
    requestBlePermissionsIfNeeded()
  }

  private fun requestBlePermissionsIfNeeded() {
    val permsList = mutableListOf(
      android.Manifest.permission.ACCESS_FINE_LOCATION,
      android.Manifest.permission.ACCESS_COARSE_LOCATION
    )
    if (Build.VERSION.SDK_INT >= 31) {
      permsList.add(android.Manifest.permission.BLUETOOTH_SCAN)
      permsList.add(android.Manifest.permission.BLUETOOTH_ADVERTISE)
      permsList.add(android.Manifest.permission.BLUETOOTH_CONNECT)
    }
    val toRequest = permsList.filter {
      ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
    }
    if (toRequest.isNotEmpty()) {
      ActivityCompat.requestPermissions(this, toRequest.toTypedArray(), 4201)
    }
  }

  override fun onDestroy() {
    super.onDestroy()
    if (instance == this) {
      instance = null
    }
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode == 4201) {
      val allGranted = grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }
      android.util.Log.i("MainActivity", "BLE permissions request 4201 result granted=$allGranted")
      if (allGranted) {
        try {
          // BleManager.init() is safe to call again — it's idempotent.
          // We re-init here in case start_mesh() (which calls ble_init from Rust)
          // hasn't run yet when permissions were granted, ensuring localNodeId
          // and localName are always populated before advertising starts.
          BleManager.ensureInit(this)
          BleManager.startAdvertising(this)
          BleManager.startScanning(this)
          NativeBridge.onPermissionsGranted()
        } catch (e: Throwable) {
          android.util.Log.w("MainActivity", "Error starting BLE post-permissions: ${e.message}")
        }
      }
    }
  }

  override fun onResume() {
    super.onResume()
    NfcManager.enableForegroundDispatch(this)
  }

  override fun onPause() {
    super.onPause()
    NfcManager.disableForegroundDispatch(this)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    NfcManager.handleIntent(intent)
  }

  companion object {
    var instance: MainActivity? = null

    @JvmStatic
    fun installApk(apkPath: String) {
      val ctx = instance ?: return
      val file = File(apkPath)
      val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      ctx.startActivity(intent)
    }
  }
}
