package com.vortex.mesh

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import java.io.File

/**
 * Installs a downloaded VOID APK without depending on a live Activity.
 * The previous MainActivity.instance latch failed whenever the process
 * stayed alive (foreground service) after the Activity was destroyed,
 * and also swallowed path/permission errors as "MainActivity unavailable".
 */
object ApkInstaller {
    private const val TAG = "VoidUpdater"
    private const val PREFS = "void_updater"
    private const val KEY_PENDING = "pending_apk"
    const val NEED_PERMISSION = "NEED_INSTALL_PERMISSION"

    @JvmStatic
    fun install(context: Context, apkPath: String): String {
        return try {
            val app = context.applicationContext
            val staged = stageApk(app, File(apkPath))
            persistPending(app, staged.absolutePath)
            if (Build.VERSION.SDK_INT >= 26 && !app.packageManager.canRequestPackageInstalls()) {
                requestUnknownSources(app)
                Log.i(TAG, "install permission missing; opened settings")
                return NEED_PERMISSION
            }
            try {
                commitSession(app, staged)
                Log.i(TAG, "package installer session committed")
            } catch (error: Throwable) {
                Log.w(TAG, "package installer failed, falling back to viewer: ${error.message}")
                launchLegacyViewer(app, staged)
            }
            ""
        } catch (error: Throwable) {
            Log.e(TAG, "APK install failed", error)
            error.message ?: error.javaClass.simpleName
        }
    }

    @JvmStatic
    fun canInstall(context: Context): Boolean =
        Build.VERSION.SDK_INT < 26 || context.applicationContext.packageManager.canRequestPackageInstalls()

    @JvmStatic
    fun retryPending(context: Context): String? {
        val pending = pendingPath(context) ?: return null
        if (!File(pending).isFile) {
            persistPending(context.applicationContext, null)
            return null
        }
        val result = install(context, pending)
        return result.ifEmpty { null }
    }

    private fun stageApk(app: Context, source: File): File {
        val original = source.canonicalFile
        if (!original.isFile || original.length() == 0L) {
            throw IllegalArgumentException("Pobrany APK nie istnieje")
        }
        val destDir = File(app.cacheDir, "updates")
        if (!destDir.exists() && !destDir.mkdirs()) {
            throw IllegalStateException("Nie mozna utworzyc katalogu aktualizacji")
        }
        val dest = File(destDir, "update.apk").canonicalFile
        if (original.path != dest.path) {
            original.copyTo(dest, overwrite = true)
        }
        if (!dest.isFile || dest.length() == 0L) {
            throw IllegalStateException("Nie udalo sie przygotowac APK do instalacji")
        }
        return dest
    }

    private fun commitSession(app: Context, apk: File) {
        val installer = app.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(app.packageName)
        if (Build.VERSION.SDK_INT >= 34) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
        }
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            session.openWrite("void.apk", 0, apk.length()).use { output ->
                apk.inputStream().use { input -> input.copyTo(output) }
                session.fsync(output)
            }
            val callback = Intent(app, InstallResultReceiver::class.java).apply {
                action = InstallResultReceiver.ACTION
            }
            var flags = PendingIntent.FLAG_UPDATE_CURRENT
            flags = if (Build.VERSION.SDK_INT >= 31) {
                flags or PendingIntent.FLAG_MUTABLE
            } else {
                flags
            }
            val pending = PendingIntent.getBroadcast(app, sessionId, callback, flags)
            session.commit(pending.intentSender)
        }
    }

    private fun launchLegacyViewer(app: Context, apk: File) {
        val uri = FileProvider.getUriForFile(app, "${app.packageName}.fileprovider", apk)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val resolvers = app.packageManager.queryIntentActivities(intent, 0)
        for (resolve in resolvers) {
            app.grantUriPermission(
                resolve.activityInfo.packageName,
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION
            )
        }
        app.startActivity(intent)
    }

    private fun requestUnknownSources(app: Context) {
        val settings = Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${app.packageName}")
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        app.startActivity(settings)
    }

    private fun persistPending(app: Context, path: String?) {
        val editor = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        if (path.isNullOrBlank()) editor.remove(KEY_PENDING) else editor.putString(KEY_PENDING, path)
        editor.apply()
    }

    private fun pendingPath(context: Context): String? =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_PENDING, null)

    fun clearPending(context: Context) {
        persistPending(context.applicationContext, null)
    }
}
