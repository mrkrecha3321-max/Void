package com.vortex.mesh

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Foreground service that keeps the BLE mesh transport alive after the UI is
 * backgrounded or the screen is turned off.
 *
 * It does not do BLE work itself — [BleManager] owns the scanning/advertising/
 * GATT state. The service simply:
 *  - creates a long-lived notification (mandatory for a foreground service);
 *  - raises the process priority so the system is less likely to kill it;
 *  - restarts scanning/advertising on [onStartCommand] to recover from
 *    transient Bluetooth toggles.
 *
 * Android 14 (API 34) requires a foregroundServiceType and the matching
 * FOREGROUND_SERVICE_CONNECTED_DEVICE runtime permission, both declared in the
 * manifest. We never try to bypass the OS restrictions: start is best-effort
 * and the BLE layer handles absence of a service gracefully.
 */
class BleForegroundService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (error: Throwable) {
            // On Android 12+ the OS can throw ForegroundServiceStartNotAllowed
            // Exception when started from the background without an exemption.
            // We do NOT circumvent it; BLE continues opportunistically and
            // the UI restarts the service on resume.
            android.util.Log.w("VoidBleService", "startForeground failed: ${error.message}")
        }

        // Best-effort restart of scanning/advertising if Bluetooth is enabled.
        try {
            val ctx = applicationContext
            if (BleManager.startScanning(ctx)) {
                android.util.Log.i("VoidBleService", "Scanning active in background")
            }
            if (BleManager.startAdvertising(ctx)) {
                android.util.Log.i("VoidBleService", "Advertising active in background")
            }
        } catch (error: Throwable) {
            android.util.Log.w("VoidBleService", "Background BLE restart failed", error)
        }

        return START_STICKY
    }

    override fun onDestroy() {
        try {
            // Leave scanning/advertising state managed by BleManager; the next
            // UI lifecycle call reconciles it.
        } finally {
            super.onDestroy()
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Połączenie mesh",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Utrzymuje połączenie BLE sieci Void w tle"
                setShowBadge(false)
            }
            manager?.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
        val contentIntent = launchIntent?.let {
            PendingIntent.getActivity(this, 0, it, pendingFlags)
        }

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Void — sieć mesh aktywna")
            .setContentText("Połączenie BLE działa w tle")
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
        contentIntent?.let { builder.setContentIntent(it) }
        return builder.build()
    }

    companion object {
        private const val CHANNEL_ID = "void_ble_service"
        private const val NOTIFICATION_ID = 0x564F4944 // "VOID"

        @JvmStatic
        fun start(context: Context) {
            val intent = Intent(context, BleForegroundService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (error: Throwable) {
                android.util.Log.w("VoidBleService", "Unable to start service", error)
            }
        }

        @JvmStatic
        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, BleForegroundService::class.java))
            } catch (error: Throwable) {
                android.util.Log.w("VoidBleService", "Unable to stop service", error)
            }
        }
    }
}
