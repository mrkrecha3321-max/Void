package com.vortex.mesh

import android.content.Context

// Kotlin-to-Rust JNI declarations are implemented in src-tauri/src/native_bridge.rs.
object NativeBridge {
    @JvmStatic external fun setAndroidContext(context: Context)
    @JvmStatic external fun setClassLoader(classLoader: ClassLoader)
    @JvmStatic external fun onPeerDiscovered(address: String, shortId: String, name: String, rssi: Int)
    @JvmStatic external fun onPeerConnecting(address: String)
    @JvmStatic external fun onPeerConnected(address: String)
    @JvmStatic external fun onPeerDisconnected(address: String)
    @JvmStatic external fun onMessageReceived(address: String, text: String)
    @JvmStatic external fun onTransportSent(msgId: String)
    @JvmStatic external fun onTransportFailed(msgId: String, reason: String)
    @JvmStatic external fun onBleError(message: String)
    @JvmStatic external fun onUpdateStatus(status: String, message: String)
    @JvmStatic external fun onNfcTagRead(payload: String)
    @JvmStatic external fun onNfcError(message: String)
    @JvmStatic external fun onPermissionsGranted()

    @JvmStatic
    fun connectToPeer(ctx: Context, address: String): Boolean {
        return BleManager.connectToPeer(ctx, address)
    }

    @JvmStatic
    fun connectToPeer(address: String): Boolean {
        return BleManager.connectToPeer(address)
    }
}
