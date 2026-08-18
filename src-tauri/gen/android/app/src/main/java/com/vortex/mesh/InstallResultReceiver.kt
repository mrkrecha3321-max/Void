package com.vortex.mesh

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log

class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(
            PackageInstaller.EXTRA_STATUS,
            PackageInstaller.STATUS_FAILURE
        )
        Log.i(TAG, "package installer status=$status")
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = extraIntent(intent) ?: return
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                try {
                    context.startActivity(confirm)
                } catch (error: Throwable) {
                    Log.e(TAG, "could not show installer confirmation", error)
                    ApkInstaller.clearPending(context)
                    NativeBridgeSafeUpdate.onError("Nie mozna otworzyc instalatora Androida")
                }
            }
            PackageInstaller.STATUS_SUCCESS -> {
                ApkInstaller.clearPending(context)
                NativeBridgeSafeUpdate.onInstalled()
            }
            else -> {
                ApkInstaller.clearPending(context)
                val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                    ?: "Instalacja APK nie powiodla sie (status=$status)"
                NativeBridgeSafeUpdate.onError(message)
            }
        }
    }

    private fun extraIntent(intent: Intent): Intent? =
        if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_INTENT)
        }

    companion object {
        const val ACTION = "com.vortex.mesh.UPDATE_COMMITTED"
        private const val TAG = "VoidUpdater"
    }
}

private object NativeBridgeSafeUpdate {
    fun onInstalled() {
        try { NativeBridge.onUpdateStatus("installed", "") } catch (_: Throwable) {}
    }

    fun onError(message: String) {
        try { NativeBridge.onUpdateStatus("failed", message) } catch (_: Throwable) {}
    }
}
