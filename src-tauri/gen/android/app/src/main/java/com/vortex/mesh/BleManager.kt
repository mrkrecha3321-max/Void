package com.vortex.mesh

import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Log
import androidx.core.content.ContextCompat
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

object BleManager {
    val SERVICE_UUID: UUID = UUID.fromString("5f9b34fb-9b4a-4a0c-8b48-4b0e3c1b6b01")
    val MESSAGE_CHAR_UUID: UUID = UUID.fromString("5f9b34fb-9b4a-4a0c-8b48-4b0e3c1b6b02")
    private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    private const val TAG = "VoidBle"
    private const val MAX_RX_BUFFERS = 128
    private const val MAX_RX_BUFFERS_PER_DEVICE = 16
    private const val RX_BUFFER_TIMEOUT_MS = 30_000L
    private const val CLEANUP_INTERVAL_MS = 10_000L
    private const val PREFS = "void_ble_state"
    private const val PENDING_DIR = "pending_rx"

    private var appContext: Context? = null
    private var bluetoothManager: BluetoothManager? = null
    private var adapter: BluetoothAdapter? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private var scanner: BluetoothLeScanner? = null
    private var gattServer: BluetoothGattServer? = null

    private val discoveredDevices = ConcurrentHashMap<String, BluetoothDevice>()
    private val connectingAddresses = ConcurrentHashMap.newKeySet<String>()
    private val connectedGatts = ConcurrentHashMap<String, BluetoothGatt>()
    private val serverConnectedDevices = ConcurrentHashMap<String, BluetoothDevice>()
    private val peerShortIds = ConcurrentHashMap<String, String>()
    private val negotiatedMtu = ConcurrentHashMap<String, Int>()
    private val linkBusy = ConcurrentHashMap.newKeySet<String>()

    private data class ChunkKey(val address: String, val msgId: Int)
    private class ChunkBuffer(val totalChunks: Int) {
        val chunks = mutableMapOf<Int, ByteArray>()
        @Volatile var lastUpdate: Long = System.currentTimeMillis()
    }
    private val rxBuffers = ConcurrentHashMap<ChunkKey, ChunkBuffer>()

    private val writeQueues = ConcurrentHashMap<String, BleOutboundQueue>()
    private val writesInFlight = ConcurrentHashMap.newKeySet<String>()
    private val writeTimeouts = ConcurrentHashMap<String, Runnable>()
    private val reconnectAttempts = ConcurrentHashMap<String, Int>()
    private val reconnectRunnables = ConcurrentHashMap<String, Runnable>()

    private val nextMessageId = AtomicInteger(0)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val ioExecutor = Executors.newSingleThreadExecutor { thread ->
        Thread(thread, "VoidBleIo").apply { isDaemon = true }
    }
    private val rustReady = AtomicBoolean(false)
    private val advertisingActive = AtomicBoolean(false)
    private val scanningActive = AtomicBoolean(false)
    private val gattServerReady = AtomicBoolean(false)

    private val cleanupRunnable = object : Runnable {
        override fun run() {
            cleanupStaleBuffers()
            mainHandler.postDelayed(this, CLEANUP_INTERVAL_MS)
        }
    }

    private var localNodeId: String = ""
    private var localName: String = "Void User"
    @Volatile private var hiddenMode: Boolean = false
    @Volatile private var batterySaveMode: Boolean = false
    @Volatile private var advertisingRequested: Boolean = false
    @Volatile private var scanningRequested: Boolean = false

    @JvmStatic fun getLocalNodeId(): String = localNodeId
    @JvmStatic fun getLocalName(): String = localName

    private fun startCleanupLoop() {
        mainHandler.removeCallbacks(cleanupRunnable)
        mainHandler.post(cleanupRunnable)
    }

    private fun cleanupStaleBuffers() {
        val cutoff = System.currentTimeMillis() - RX_BUFFER_TIMEOUT_MS
        rxBuffers.entries.removeIf { it.value.lastUpdate < cutoff }
    }

    private fun allocateMessageId(): Int =
        nextMessageId.getAndUpdate { (it + 1) and 0xFFFF } and 0xFFFF

    private fun hasPermission(ctx: Context, permission: String): Boolean =
        ContextCompat.checkSelfPermission(ctx, permission) == PackageManager.PERMISSION_GRANTED

    private fun canBle(ctx: Context): Boolean = if (Build.VERSION.SDK_INT >= 31) {
        hasPermission(ctx, android.Manifest.permission.BLUETOOTH_SCAN) &&
            hasPermission(ctx, android.Manifest.permission.BLUETOOTH_ADVERTISE) &&
            hasPermission(ctx, android.Manifest.permission.BLUETOOTH_CONNECT)
    } else {
        hasPermission(ctx, android.Manifest.permission.ACCESS_FINE_LOCATION)
    }

    private fun mtuFor(address: String): Int =
        negotiatedMtu[address] ?: BleLinkPolicy.DEFAULT_MTU

    @JvmStatic
    fun init(ctx: Context, nodeId: String, name: String) {
        try {
            appContext = ctx.applicationContext
            localNodeId = nodeId
            localName = name.take(80).ifBlank { "Void User" }
            bluetoothManager = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
            adapter = bluetoothManager?.adapter
            persistPrefs()
            startCleanupLoop()
            ensureForegroundService(ctx)
            Log.i(TAG, "init nodeSuffix=${localNodeId.takeLast(8)}")
        } catch (error: Throwable) {
            bluetoothManager = null
            adapter = null
            reportError("BLE init failed", error)
        }
    }

    @JvmStatic
    fun ensureForegroundService(ctx: Context) {
        val app = ctx.applicationContext
        appContext = app
        val intent = Intent(app, MeshForegroundService::class.java)
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                app.startForegroundService(intent)
            } else {
                app.startService(intent)
            }
        } catch (error: Exception) {
            Log.w(TAG, "FGS start not allowed: ${error.message}")
        }
    }

    @JvmStatic
    fun restoreIfNeeded(ctx: Context) {
        appContext = ctx.applicationContext
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (localNodeId.isBlank()) {
            localNodeId = prefs.getString("nodeId", "") ?: ""
            localName = prefs.getString("name", "Void User") ?: "Void User"
        }
        hiddenMode = prefs.getBoolean("hidden", hiddenMode)
        batterySaveMode = prefs.getBoolean("batterySave", batterySaveMode)
        advertisingRequested = prefs.getBoolean("advertisingRequested", advertisingRequested)
        scanningRequested = prefs.getBoolean("scanningRequested", scanningRequested)
        if (bluetoothManager == null) {
            bluetoothManager = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
            adapter = bluetoothManager?.adapter
        }
        startCleanupLoop()
        if (!canBle(ctx)) {
            Log.i(TAG, "restore skipped: missing BLE permission")
            return
        }
        if (advertisingRequested) startAdvertising(ctx)
        if (scanningRequested) startScanning(ctx)
    }

    @JvmStatic
    fun onRustReady() {
        rustReady.set(true)
        Log.i(TAG, "rust ready")
        val ctx = appContext ?: return
        ioExecutor.execute { flushPendingRx(ctx) }
    }

    @JvmStatic
    fun onBluetoothEnabled(ctx: Context) {
        Log.i(TAG, "bluetooth enabled; restoring requested roles")
        if (advertisingRequested) startAdvertising(ctx)
        if (scanningRequested) startScanning(ctx)
    }

    @JvmStatic
    fun onBluetoothDisabled() {
        Log.i(TAG, "bluetooth disabled; clearing links")
        advertisingActive.set(false)
        scanningActive.set(false)
        val addresses = (connectedGatts.keys + serverConnectedDevices.keys + writeQueues.keys).toSet()
        addresses.forEach { address ->
            failLink(address, "Bluetooth wylaczony")
            NativeBridgeSafe.onPeerDisconnected(address)
        }
        connectedGatts.values.forEach { gatt ->
            try { gatt.close() } catch (_: Throwable) {}
        }
        connectedGatts.clear()
        serverConnectedDevices.clear()
        connectingAddresses.clear()
    }

    @JvmStatic
    fun updateSettings(ctx: Context, hidden: Boolean, batterySave: Boolean) {
        val hiddenChanged = hiddenMode != hidden
        val batteryChanged = batterySaveMode != batterySave
        hiddenMode = hidden
        batterySaveMode = batterySave
        persistPrefs()
        if (!canBle(ctx)) return

        if (hiddenChanged) {
            if (hidden) {
                stopAdvertisingInternal(closeServer = false)
            } else if (advertisingRequested) {
                startAdvertising(ctx)
            }
        }
        if (batteryChanged && scanningRequested) {
            stopScanningInternal()
            startScanning(ctx)
        }
    }

    private fun persistPrefs() {
        val ctx = appContext ?: return
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("nodeId", localNodeId)
            .putString("name", localName)
            .putBoolean("hidden", hiddenMode)
            .putBoolean("batterySave", batterySaveMode)
            .putBoolean("advertisingRequested", advertisingRequested)
            .putBoolean("scanningRequested", scanningRequested)
            .apply()
    }

    private fun handleReceivedBytes(address: String, bytes: ByteArray) {
        try {
            val frame = BleFrameCodec.decode(bytes) ?: return
            val key = ChunkKey(address, frame.messageId)
            if (!rxBuffers.containsKey(key)) {
                if (rxBuffers.size >= MAX_RX_BUFFERS) return
                if (rxBuffers.keys.count { it.address == address } >= MAX_RX_BUFFERS_PER_DEVICE) return
            }
            val buffer = rxBuffers.compute(key) { _, existing ->
                if (existing == null || existing.totalChunks != frame.totalChunks) {
                    ChunkBuffer(frame.totalChunks)
                } else existing
            } ?: return

            synchronized(buffer) {
                buffer.chunks[frame.chunkIndex] = frame.payload
                buffer.lastUpdate = System.currentTimeMillis()
                if (buffer.chunks.size == buffer.totalChunks &&
                    (0 until buffer.totalChunks).all { buffer.chunks.containsKey(it) }
                ) {
                    val output = ByteArrayOutputStream()
                    for (index in 0 until buffer.totalChunks) {
                        output.write(buffer.chunks[index] ?: return)
                    }
                    rxBuffers.remove(key, buffer)
                    val message = output.toByteArray()
                    if (message.size <= BleFrameCodec.MAX_MESSAGE_BYTES) {
                        dispatchCompleteMessage(address, String(message, Charsets.UTF_8))
                    }
                }
            }
        } catch (error: Throwable) {
            reportError("BLE receive failed", error)
        }
    }

    private fun dispatchCompleteMessage(address: String, payload: String) {
        Log.i(TAG, "rx complete address=$address bytes=${payload.length}")
        if (rustReady.get()) {
            NativeBridgeSafe.onMessageReceived(address, payload)
            return
        }
        val ctx = appContext ?: return
        ioExecutor.execute { persistPendingRx(ctx, address, payload) }
    }

    private fun persistPendingRx(ctx: Context, address: String, payload: String) {
        if (payload.length > BleFrameCodec.MAX_MESSAGE_BYTES || address.length > 32) return
        val dir = File(ctx.filesDir, PENDING_DIR)
        if (!dir.exists() && !dir.mkdirs()) return
        val existing = dir.listFiles()?.size ?: 0
        if (existing >= 256) return
        val file = File(dir, "${System.currentTimeMillis()}-${UUID.randomUUID()}.rx")
        val tmp = File(dir, "${file.name}.tmp")
        try {
            tmp.writeText("$address\n$payload")
            if (!tmp.renameTo(file)) tmp.delete()
        } catch (error: Throwable) {
            tmp.delete()
            Log.w(TAG, "pending rx persist failed: ${error.message}")
        }
    }

    private fun flushPendingRx(ctx: Context) {
        val dir = File(ctx.filesDir, PENDING_DIR)
        val files = dir.listFiles()?.sortedBy { it.name } ?: return
        for (file in files) {
            try {
                val text = file.readText()
                val split = text.indexOf('\n')
                if (split > 0) {
                    val address = text.substring(0, split)
                    val payload = text.substring(split + 1)
                    NativeBridgeSafe.onMessageReceived(address, payload)
                }
                if (!file.delete()) {
                    Log.w(TAG, "could not delete pending rx file")
                }
            } catch (error: Throwable) {
                Log.w(TAG, "pending rx replay failed: ${error.message}")
            }
        }
    }

    @JvmStatic
    fun startAdvertising(ctx: Context): Boolean {
        advertisingRequested = true
        persistPrefs()
        ensureForegroundService(ctx)
        if (hiddenMode) {
            stopAdvertisingInternal(closeServer = false)
            return true
        }
        return try {
            appContext = ctx.applicationContext
            startCleanupLoop()
            if (!canBle(ctx) || localNodeId.length != 35 || !localNodeId.startsWith("VX-")) return false
            val currentAdapter = adapter ?: bluetoothManager?.adapter ?: return false
            if (!currentAdapter.isEnabled) return false
            advertiser = currentAdapter.bluetoothLeAdvertiser ?: return false
            startGattServerIfNeeded(ctx)
            if (advertisingActive.get()) {
                Log.i(TAG, "advertising already active")
                return true
            }
            val settings = AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
                .setConnectable(true)
                .build()
            val serviceUuid = ParcelUuid(SERVICE_UUID)
            val data = AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .addServiceUuid(serviceUuid)
                .build()
            val shortTag = localNodeId.takeLast(8).uppercase()
            val scanResponse = AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .addServiceData(serviceUuid, shortTag.toByteArray(Charsets.US_ASCII))
                .build()
            advertiser?.startAdvertising(settings, data, scanResponse, advertiseCallback)
            advertisingActive.set(true)
            Log.i(TAG, "advertising start requested")
            true
        } catch (error: Throwable) {
            reportError("BLE advertising failed", error)
            false
        }
    }

    @JvmStatic
    fun stopAdvertising(ctx: Context) {
        advertisingRequested = false
        persistPrefs()
        stopAdvertisingInternal(closeServer = true)
    }

    private fun stopAdvertisingInternal(closeServer: Boolean) {
        try { advertiser?.stopAdvertising(advertiseCallback) } catch (_: Throwable) {}
        advertisingActive.set(false)
        if (closeServer && serverConnectedDevices.isEmpty() && connectedGatts.isEmpty()) {
            try { gattServer?.close() } catch (_: Throwable) {}
            gattServer = null
            gattServerReady.set(false)
        }
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
            advertisingActive.set(true)
            Log.i(TAG, "advertise started")
        }

        override fun onStartFailure(errorCode: Int) {
            advertisingActive.set(false)
            if (errorCode == ADVERTISE_FAILED_ALREADY_STARTED) {
                advertisingActive.set(true)
                Log.i(TAG, "advertise already started")
                return
            }
            safeBleError("Advertise start failed: $errorCode")
        }
    }

    private val gattServerCallback = object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            Log.i(TAG, "server state address=${device.address} status=$status newState=$newState")
            try {
                if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
                    serverConnectedDevices[device.address] = device
                    reconnectAttempts.remove(device.address)
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                    serverConnectedDevices.remove(device.address)
                    failLink(device.address, "GATT server disconnect status=$status")
                    NativeBridgeSafe.onPeerDisconnected(device.address)
                    scheduleReconnect(device.address)
                }
            } catch (error: Throwable) {
                reportError("GATT server state callback failed", error)
            }
        }

        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
            negotiatedMtu[device.address] = mtu
            Log.i(TAG, "server mtu address=${device.address} mtu=$mtu")
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray
        ) {
            var responseStatus = BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED
            try {
                responseStatus = when {
                    characteristic.uuid != MESSAGE_CHAR_UUID || preparedWrite ->
                        BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED
                    offset != 0 -> BluetoothGatt.GATT_INVALID_OFFSET
                    BleFrameCodec.decode(value) == null -> BluetoothGatt.GATT_INVALID_ATTRIBUTE_LENGTH
                    else -> {
                        handleReceivedBytes(device.address, value)
                        BluetoothGatt.GATT_SUCCESS
                    }
                }
            } catch (error: Throwable) {
                responseStatus = BluetoothGatt.GATT_FAILURE
                reportError("GATT server write failed", error)
            }
            if (responseNeeded) {
                try { gattServer?.sendResponse(device, requestId, responseStatus, 0, null) } catch (_: Throwable) {}
            }
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray
        ) {
            val valid = descriptor.uuid == CCCD_UUID &&
                !preparedWrite && offset == 0 &&
                value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            if (responseNeeded) {
                try {
                    gattServer?.sendResponse(
                        device,
                        requestId,
                        if (valid) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED,
                        0,
                        null
                    )
                } catch (_: Throwable) {}
            }
            if (valid) {
                Log.i(TAG, "server cccd enabled address=${device.address}")
                try { NativeBridge.onPeerConnected(device.address) } catch (error: Throwable) {
                    reportError("Peer connected callback failed", error)
                }
            }
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            Log.i(TAG, "notify sent address=${device.address} status=$status")
            completeWrite(device.address, status == BluetoothGatt.GATT_SUCCESS, "notify status=$status")
        }
    }

    private fun startGattServerIfNeeded(ctx: Context) {
        try {
            if (!canBle(ctx)) return
            if (gattServer != null && gattServerReady.get()) return
            try { gattServer?.close() } catch (_: Throwable) {}
            gattServer = bluetoothManager?.openGattServer(ctx, gattServerCallback)
            val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
            val messageCharacteristic = BluetoothGattCharacteristic(
                MESSAGE_CHAR_UUID,
                BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                BluetoothGattCharacteristic.PERMISSION_WRITE
            )
            val cccd = BluetoothGattDescriptor(
                CCCD_UUID,
                BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE
            )
            messageCharacteristic.addDescriptor(cccd)
            service.addCharacteristic(messageCharacteristic)
            if (gattServer?.addService(service) != true) {
                throw IllegalStateException("Could not add VOID GATT service")
            }
            gattServerReady.set(true)
            Log.i(TAG, "gatt server started")
        } catch (error: Throwable) {
            try { gattServer?.close() } catch (_: Throwable) {}
            gattServer = null
            gattServerReady.set(false)
            reportError("GATT server startup failed", error)
        }
    }

    @JvmStatic
    fun startScanning(ctx: Context): Boolean {
        scanningRequested = true
        persistPrefs()
        ensureForegroundService(ctx)
        return try {
            appContext = ctx.applicationContext
            if (!canBle(ctx)) return false
            val currentAdapter = adapter ?: bluetoothManager?.adapter ?: return false
            if (!currentAdapter.isEnabled) return false
            scanner = currentAdapter.bluetoothLeScanner ?: return false
            if (scanningActive.get()) {
                Log.i(TAG, "scan already active")
                return true
            }
            val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build()
            val settings = ScanSettings.Builder()
                .setScanMode(
                    if (batterySaveMode) ScanSettings.SCAN_MODE_LOW_POWER
                    else ScanSettings.SCAN_MODE_LOW_LATENCY
                )
                .build()
            scanner?.startScan(listOf(filter), settings, scanCallback)
            scanningActive.set(true)
            Log.i(TAG, "scan start requested")
            true
        } catch (error: Throwable) {
            reportError("BLE scanning failed", error)
            false
        }
    }

    @JvmStatic
    fun stopScanning(ctx: Context) {
        scanningRequested = false
        persistPrefs()
        stopScanningInternal()
    }

    private fun stopScanningInternal() {
        try {
            scanner?.stopScan(scanCallback)
        } catch (error: Throwable) {
            reportError("Stopping BLE scan failed", error)
        }
        scanningActive.set(false)
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            try {
                val device = result.device ?: return
                val address = device.address
                val data = result.scanRecord?.getServiceData(ParcelUuid(SERVICE_UUID)) ?: return
                val shortId = String(data, Charsets.US_ASCII).uppercase()
                if (shortId.length != 8 || !shortId.all { it in '0'..'9' || it in 'A'..'F' }) return

                peerShortIds.putIfAbsent(shortId, address)
                discoveredDevices[address] = device
                NativeBridgeSafe.onPeerDiscovered(address, shortId, "Kontakt ($shortId)", result.rssi)
                appContext?.let { context ->
                    if (!connectedGatts.containsKey(address) &&
                        !serverConnectedDevices.containsKey(address) &&
                        !connectingAddresses.contains(address)
                    ) {
                        connectToPeer(context, address)
                    }
                }
            } catch (error: Throwable) {
                reportError("BLE scan result failed", error)
            }
        }

        override fun onScanFailed(errorCode: Int) {
            scanningActive.set(false)
            safeBleError("Scan failed: $errorCode")
        }
    }

    @JvmStatic
    fun connectToPeer(address: String): Boolean =
        appContext?.let { connectToPeer(it, address) } ?: false

    @JvmStatic
    fun connectToPeer(ctx: Context, deviceAddress: String): Boolean {
        return try {
            appContext = ctx.applicationContext
            if (!canBle(ctx)) return false
            if (connectedGatts.containsKey(deviceAddress) || serverConnectedDevices.containsKey(deviceAddress)) {
                return true
            }
            if (!connectingAddresses.add(deviceAddress)) return true
            NativeBridgeSafe.onPeerConnecting(deviceAddress)
            val currentAdapter = adapter ?: bluetoothManager?.adapter ?: run {
                connectingAddresses.remove(deviceAddress)
                return false
            }
            val device = discoveredDevices[deviceAddress] ?: currentAdapter.getRemoteDevice(deviceAddress)
            val attempt = reconnectAttempts[deviceAddress] ?: 0
            val autoConnect = BleLinkPolicy.shouldUseAutoConnect(attempt)
            Log.i(TAG, "connect stage=connectGatt address=$deviceAddress attempt=$attempt autoConnect=$autoConnect")
            val gatt = if (Build.VERSION.SDK_INT >= 23) {
                device.connectGatt(ctx, autoConnect, gattCallback, BluetoothDevice.TRANSPORT_LE)
            } else {
                device.connectGatt(ctx, autoConnect, gattCallback)
            }
            if (gatt == null) {
                connectingAddresses.remove(deviceAddress)
                false
            } else {
                true
            }
        } catch (error: Throwable) {
            connectingAddresses.remove(deviceAddress)
            reportError("GATT connect failed", error)
            false
        }
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            val address = gatt.device.address
            Log.i(TAG, "client state address=$address status=$status newState=$newState")
            try {
                connectingAddresses.remove(address)
                if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
                    connectedGatts[address] = gatt
                    reconnectAttempts.remove(address)
                    if (!gatt.requestMtu(512)) {
                        Log.i(TAG, "requestMtu failed address=$address; discovering at default MTU")
                        gatt.discoverServices()
                    }
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                    connectedGatts.remove(address, gatt)
                    failLink(address, "GATT client disconnect status=$status")
                    NativeBridgeSafe.onPeerDisconnected(address)
                    try { gatt.close() } catch (_: Throwable) {}
                    scheduleReconnect(address)
                }
            } catch (error: Throwable) {
                connectingAddresses.remove(address)
                reportError("GATT state callback failed", error)
            }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            negotiatedMtu[gatt.device.address] = if (status == BluetoothGatt.GATT_SUCCESS) mtu else BleLinkPolicy.DEFAULT_MTU
            Log.i(TAG, "client mtu address=${gatt.device.address} mtu=$mtu status=$status")
            try { gatt.discoverServices() } catch (error: Throwable) {
                reportError("GATT service discovery start failed", error)
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            Log.i(TAG, "services discovered address=${gatt.device.address} status=$status")
            if (status == BluetoothGatt.GATT_SUCCESS) {
                enableNotifications(gatt)
            } else {
                safeBleError("Service discovery failed: $status")
            }
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            Log.i(TAG, "cccd write address=${gatt.device.address} status=$status")
            linkBusy.remove(gatt.device.address)
            if (descriptor.uuid == CCCD_UUID && status == BluetoothGatt.GATT_SUCCESS) {
                try { NativeBridge.onPeerConnected(gatt.device.address) } catch (error: Throwable) {
                    reportError("Peer connected callback failed", error)
                }
                mainHandler.post { drainWriteQueue(gatt.device.address) }
            } else if (descriptor.uuid == CCCD_UUID) {
                safeBleError("CCCD write failed: $status")
            }
        }

        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int
        ) {
            if (characteristic.uuid == MESSAGE_CHAR_UUID) {
                Log.i(TAG, "write complete address=${gatt.device.address} status=$status")
                completeWrite(gatt.device.address, status == BluetoothGatt.GATT_SUCCESS, "write status=$status")
            }
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (characteristic.uuid == MESSAGE_CHAR_UUID) {
                handleReceivedBytes(gatt.device.address, characteristic.value ?: return)
            }
        }
    }

    @JvmStatic
    fun sendMessage(ctx: Context, deviceAddress: String, text: String): Boolean =
        sendMessage(ctx, deviceAddress, text, "legacy-${allocateMessageId()}")

    @JvmStatic
    fun sendMessage(ctx: Context, deviceAddress: String, text: String, meshMsgId: String): Boolean {
        return try {
            appContext = ctx.applicationContext
            if (!canBle(ctx) || meshMsgId.isBlank()) return false
            val bytes = text.toByteArray(Charsets.UTF_8)
            if (bytes.isEmpty() || bytes.size > BleFrameCodec.MAX_MESSAGE_BYTES) return false
            val existing = writeQueues[deviceAddress]
            if (existing?.contains(meshMsgId) == true) {
                Log.i(TAG, "skip duplicate queue msgId=$meshMsgId")
                return true
            }
            if (!serverConnectedDevices.containsKey(deviceAddress) && !connectedGatts.containsKey(deviceAddress)) {
                connectToPeer(ctx, deviceAddress)
                return false
            }

            val frames = BleFrameCodec.encode(bytes, allocateMessageId(), mtuFor(deviceAddress))
            if (frames.isEmpty()) return false
            val queue = writeQueues.computeIfAbsent(deviceAddress) { BleOutboundQueue() }
            val status = queue.enqueue(meshMsgId, frames)
            if (status == EnqueueStatus.REJECTED) return false
            Log.i(TAG, "queued meshMsgId=$meshMsgId frames=${frames.size} mtu=${mtuFor(deviceAddress)}")
            mainHandler.post { drainWriteQueue(deviceAddress) }
            true
        } catch (error: Throwable) {
            reportError("Queueing BLE message failed", error)
            false
        }
    }

    private fun drainWriteQueue(address: String) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post { drainWriteQueue(address) }
            return
        }
        if (linkBusy.contains(address)) return
        if (!writesInFlight.add(address)) return
        val queue = writeQueues[address]
        val frame = queue?.currentFrame()
        val msgId = queue?.currentMsgId()
        if (frame == null || msgId == null) {
            writesInFlight.remove(address)
            if (queue != null && queue.isEmpty()) writeQueues.remove(address, queue)
            return
        }

        val started = serverConnectedDevices[address]?.let { startServerNotification(it, frame) }
            ?: connectedGatts[address]?.let { startClientWrite(it, frame) }
            ?: false
        if (started) {
            val timeout = Runnable {
                if (writesInFlight.remove(address)) {
                    writeTimeouts.remove(address)
                    val result = queue.onTimeout()
                    handleWriteResult(address, result)
                    mainHandler.post { drainWriteQueue(address) }
                }
            }
            writeTimeouts.put(address, timeout)?.let { callback -> mainHandler.removeCallbacks(callback) }
            mainHandler.postDelayed(timeout, BleLinkPolicy.FRAME_TIMEOUT_MS)
        } else {
            completeWrite(address, false, "write start failed")
        }
    }

    private fun completeWrite(address: String, success: Boolean, reason: String) {
        mainHandler.post {
            writeTimeouts.remove(address)?.let { callback -> mainHandler.removeCallbacks(callback) }
            val queue = writeQueues[address]
            val result = when {
                queue == null -> WriteResult(WriteEvent.IDLE)
                success -> queue.onWriteSuccess()
                else -> queue.onWriteFailure()
            }
            writesInFlight.remove(address)
            handleWriteResult(address, result)
            val delay = if (!success && result.event == WriteEvent.NEED_WRITE) 100L else 5L
            mainHandler.postDelayed({ drainWriteQueue(address) }, delay)
        }
    }

    private fun handleWriteResult(address: String, result: WriteResult) {
        when (result.event) {
            WriteEvent.MESSAGE_SENT -> {
                result.meshMsgId?.let { NativeBridgeSafe.onTransportSent(it) }
                val queue = writeQueues[address]
                if (queue != null && queue.isEmpty()) writeQueues.remove(address, queue)
            }
            WriteEvent.MESSAGE_FAILED -> {
                result.meshMsgId?.let {
                    NativeBridgeSafe.onTransportFailed(it, result.reason ?: "BLE write failed")
                }
                val queue = writeQueues[address]
                if (queue != null && queue.isEmpty()) writeQueues.remove(address, queue)
            }
            else -> Unit
        }
    }

    private fun startServerNotification(device: BluetoothDevice, bytes: ByteArray): Boolean {
        return try {
            val service = gattServer?.getService(SERVICE_UUID) ?: return false
            val characteristic = service.getCharacteristic(MESSAGE_CHAR_UUID) ?: return false
            if (Build.VERSION.SDK_INT >= 33) {
                gattServer?.notifyCharacteristicChanged(device, characteristic, false, bytes) ==
                    BluetoothStatusCodes.SUCCESS
            } else {
                @Suppress("DEPRECATION")
                characteristic.value = bytes
                @Suppress("DEPRECATION")
                gattServer?.notifyCharacteristicChanged(device, characteristic, false) == true
            }
        } catch (error: Throwable) {
            reportError("GATT notification failed", error)
            false
        }
    }

    private fun startClientWrite(gatt: BluetoothGatt, bytes: ByteArray): Boolean {
        return try {
            val service = gatt.getService(SERVICE_UUID) ?: return false
            val characteristic = service.getCharacteristic(MESSAGE_CHAR_UUID) ?: return false
            if (Build.VERSION.SDK_INT >= 33) {
                gatt.writeCharacteristic(
                    characteristic,
                    bytes,
                    BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                ) == BluetoothStatusCodes.SUCCESS
            } else {
                @Suppress("DEPRECATION")
                characteristic.value = bytes
                @Suppress("DEPRECATION")
                characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                @Suppress("DEPRECATION")
                gatt.writeCharacteristic(characteristic)
            }
        } catch (error: Throwable) {
            reportError("GATT characteristic write failed", error)
            false
        }
    }

    private fun enableNotifications(gatt: BluetoothGatt) {
        try {
            val address = gatt.device.address
            if (!linkBusy.add(address)) return
            val service = gatt.getService(SERVICE_UUID)
                ?: throw IllegalStateException("VOID service not found")
            val characteristic = service.getCharacteristic(MESSAGE_CHAR_UUID)
                ?: throw IllegalStateException("VOID message characteristic not found")
            if (!gatt.setCharacteristicNotification(characteristic, true)) {
                throw IllegalStateException("Could not enable local notifications")
            }
            val cccd = characteristic.getDescriptor(CCCD_UUID)
                ?: throw IllegalStateException("VOID CCCD not found")
            val started = if (Build.VERSION.SDK_INT >= 33) {
                gatt.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) ==
                    BluetoothStatusCodes.SUCCESS
            } else {
                @Suppress("DEPRECATION")
                cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                @Suppress("DEPRECATION")
                gatt.writeDescriptor(cccd)
            }
            if (!started) throw IllegalStateException("Could not write VOID CCCD")
        } catch (error: Throwable) {
            linkBusy.remove(gatt.device.address)
            reportError("Enabling GATT notifications failed", error)
        }
    }

    private fun scheduleReconnect(address: String) {
        if (!advertisingRequested && !scanningRequested) return
        if (connectedGatts.containsKey(address) || serverConnectedDevices.containsKey(address)) return
        val attempt = reconnectAttempts[address] ?: 0
        if (!BleLinkPolicy.canReconnect(attempt)) {
            Log.i(TAG, "reconnect exhausted address=$address attempt=$attempt")
            return
        }
        reconnectAttempts[address] = attempt + 1
        val delay = BleLinkPolicy.reconnectDelayMs(attempt)
        Log.i(TAG, "reconnect scheduled address=$address attempt=$attempt delayMs=$delay")
        val runnable = Runnable {
            reconnectRunnables.remove(address)
            val ctx = appContext ?: return@Runnable
            connectToPeer(ctx, address)
        }
        reconnectRunnables.put(address, runnable)?.let { mainHandler.removeCallbacks(it) }
        mainHandler.postDelayed(runnable, delay)
    }

    private fun failLink(address: String, reason: String) {
        rxBuffers.keys.removeIf { it.address == address }
        writeTimeouts.remove(address)?.let { callback -> mainHandler.removeCallbacks(callback) }
        writesInFlight.remove(address)
        linkBusy.remove(address)
        connectingAddresses.remove(address)
        writeQueues.remove(address)?.failAll(reason)?.forEach { result ->
            result.meshMsgId?.let { NativeBridgeSafe.onTransportFailed(it, reason) }
        }
    }

    private fun safeBleError(message: String) {
        try { NativeBridge.onBleError(message) } catch (_: Throwable) {}
    }

    private fun reportError(prefix: String, error: Throwable) {
        Log.w(TAG, "$prefix: ${error.message}", error)
        safeBleError("$prefix: ${error.message ?: error.javaClass.simpleName}")
    }
}

private object NativeBridgeSafe {
    fun onPeerDiscovered(address: String, shortId: String, name: String, rssi: Int) {
        try { NativeBridge.onPeerDiscovered(address, shortId, name, rssi) } catch (_: Throwable) {}
    }

    fun onPeerConnecting(address: String) {
        try { NativeBridge.onPeerConnecting(address) } catch (_: Throwable) {}
    }

    fun onPeerDisconnected(address: String) {
        try { NativeBridge.onPeerDisconnected(address) } catch (_: Throwable) {}
    }

    fun onMessageReceived(address: String, payload: String) {
        try { NativeBridge.onMessageReceived(address, payload) } catch (_: Throwable) {}
    }

    fun onTransportSent(msgId: String) {
        try { NativeBridge.onTransportSent(msgId) } catch (_: Throwable) {}
    }

    fun onTransportFailed(msgId: String, reason: String) {
        try { NativeBridge.onTransportFailed(msgId, reason) } catch (_: Throwable) {}
    }
}
