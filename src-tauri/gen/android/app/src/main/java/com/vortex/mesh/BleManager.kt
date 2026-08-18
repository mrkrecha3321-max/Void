package com.vortex.mesh

import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import androidx.core.content.ContextCompat
import java.io.ByteArrayOutputStream
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * BLE transport for VOID mesh.
 *
 * Reliability contract:
 *  - every outbound [sendMessage] is associated with the full mesh message id
 *    (UUID) and the (address, linkMessageId) reassembly key;
 *  - the per-address write queue is drained one frame at a time and the next
 *    frame is only sent after the GATT callback for the previous one;
 *  - [NativeBridge.onTransportSent] fires after the LAST frame is written, not
 *    when the frames are enqueued;
 *  - a frame error/timeout/disconnect triggers retries of the whole message
 *    up to [MAX_WRITE_ATTEMPTS], then [NativeBridge.onTransportFailed];
 *  - the chunk size is derived from the negotiated MTU (ATT 3B + framing 5B),
 *    negotiated via requestMtu(517) and clamped to [BleFrameCodec.MAX_MTU].
 *
 * Long-running scanning/advertising after the UI leaves the foreground is the
 * job of [BleForegroundService]; Android 12+ background-scan limits are not
 * bypassed — when the system stops scans the service restarts them on resume.
 */
object BleManager {
    val SERVICE_UUID: UUID = UUID.fromString("5f9b34fb-9b4a-4a0c-8b48-4b0e3c1b6b01")
    val MESSAGE_CHAR_UUID: UUID = UUID.fromString("5f9b34fb-9b4a-4a0c-8b48-4b0e3c1b6b02")
    private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    private const val MAX_RX_BUFFERS = 128
    private const val MAX_RX_BUFFERS_PER_DEVICE = 16
    private const val RX_BUFFER_TIMEOUT_MS = 30_000L
    private const val CLEANUP_INTERVAL_MS = 10_000L
    private const val MAX_WRITE_ATTEMPTS = 3
    private const val FRAME_WRITE_TIMEOUT_MS = 8_000L
    private const val GATT_CONNECT_TIMEOUT_MS = 20_000L
    private const val RECONNECT_DELAY_MS = 4_000L
    private const val MAX_RECONNECT_ATTEMPTS = 6

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

    /** Per-link negotiated MTU. Defaults to 23 (BLE minimum) until onMtuChanged. */
    private val negotiatedMtu = ConcurrentHashMap<String, Int>()

    private data class ChunkKey(val address: String, val msgId: Int)
    private class ChunkBuffer(val totalChunks: Int) {
        val chunks = mutableMapOf<Int, ByteArray>()
        @Volatile var lastUpdate: Long = System.currentTimeMillis()
    }
    private val rxBuffers = ConcurrentHashMap<ChunkKey, ChunkBuffer>()

    /** One full outbound mesh message queued to a GATT address. */
    private class TxMessage(
        val meshMsgId: String,
        val frames: List<ByteArray>,
        var frameIndex: Int = 0,
        var attempts: Int = 0,
        var completed: Boolean = false
    )

    private val txQueues = ConcurrentHashMap<String, ArrayDeque<TxMessage>>()
    private val txInFlight = ConcurrentHashMap.newKeySet<String>()
    private val frameTimeouts = ConcurrentHashMap<String, Runnable>()
    private val connectTimeouts = ConcurrentHashMap<String, Runnable>()
    private val reconnectAttempts = ConcurrentHashMap<String, Int>()

    private val nextLinkMessageId = AtomicInteger(0)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val cleanupRunnable = object : Runnable {
        override fun run() {
            cleanupStaleState()
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

    private fun cleanupStaleState() {
        val cutoff = System.currentTimeMillis() - RX_BUFFER_TIMEOUT_MS
        rxBuffers.entries.removeIf { it.value.lastUpdate < cutoff }
    }

    private fun allocateLinkMessageId(): Int =
        nextLinkMessageId.getAndUpdate { (it + 1) and 0xFFFF } and 0xFFFF

    private fun hasPermission(ctx: Context, permission: String): Boolean =
        ContextCompat.checkSelfPermission(ctx, permission) == PackageManager.PERMISSION_GRANTED

    private fun canBle(ctx: Context): Boolean = if (Build.VERSION.SDK_INT >= 31) {
        hasPermission(ctx, android.Manifest.permission.BLUETOOTH_SCAN) &&
            hasPermission(ctx, android.Manifest.permission.BLUETOOTH_ADVERTISE) &&
            hasPermission(ctx, android.Manifest.permission.BLUETOOTH_CONNECT)
    } else {
        hasPermission(ctx, android.Manifest.permission.ACCESS_FINE_LOCATION)
    }

    @JvmStatic
    fun init(ctx: Context, nodeId: String, name: String) {
        try {
            appContext = ctx.applicationContext
            localNodeId = nodeId
            localName = name.take(80).ifBlank { "Void User" }
            bluetoothManager = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
            adapter = bluetoothManager?.adapter
            startCleanupLoop()
        } catch (error: Throwable) {
            bluetoothManager = null
            adapter = null
            reportError("BLE init failed", error)
        }
    }

    @JvmStatic
    fun updateSettings(ctx: Context, hidden: Boolean, batterySave: Boolean) {
        val hiddenChanged = hiddenMode != hidden
        val batteryChanged = batterySaveMode != batterySave
        hiddenMode = hidden
        batterySaveMode = batterySave
        if (!canBle(ctx)) return

        if (hiddenChanged) {
            if (hidden) stopAdvertisingInternal()
            else if (advertisingRequested) startAdvertising(ctx)
        }
        if (batteryChanged && scanningRequested) {
            stopScanningInternal()
            startScanning(ctx)
        }
    }

    @JvmStatic
    private fun handleReceivedBytes(address: String, bytes: ByteArray) {
        try {
            val frame = BleFrameCodec.decode(bytes) ?: return
            val key = ChunkKey(address, frame.messageId)
            if (!rxBuffers.containsKey(key)) {
                if (rxBuffers.size >= MAX_RX_BUFFERS) return
                if (rxBuffers.keys.count { it.address == address } >= MAX_RX_BUFFERS_PER_DEVICE) return
            }
            val buffer = rxBuffers.compute(key) { _, existing ->
                if (existing == null || existing.totalChunks != frame.totalChunks) ChunkBuffer(frame.totalChunks)
                else existing
            } ?: return

            var completedMessage: ByteArray? = null
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
                    completedMessage = output.toByteArray()
                }
            }
            completedMessage?.let { message ->
                if (message.size <= BleFrameCodec.maxMessageBytes(BleFrameCodec.MAX_MTU)) {
                    NativeBridge.onMessageReceived(address, String(message, Charsets.UTF_8))
                }
            }
        } catch (error: Throwable) {
            reportError("BLE receive failed", error)
        }
    }

    @JvmStatic
    fun startAdvertising(ctx: Context): Boolean {
        advertisingRequested = true
        if (hiddenMode) {
            stopAdvertisingInternal()
            return true
        }
        return try {
            appContext = ctx.applicationContext
            startCleanupLoop()
            if (!canBle(ctx) || localNodeId.length != 35 || !localNodeId.startsWith("VX-")) return false
            val currentAdapter = adapter ?: bluetoothManager?.adapter ?: return false
            if (!currentAdapter.isEnabled) return false
            advertiser = currentAdapter.bluetoothLeAdvertiser ?: return false

            try { advertiser?.stopAdvertising(advertiseCallback) } catch (_: Throwable) {}
            val settings = AdvertiseSettings.Builder()
                .setAdvertiseMode(
                    if (batterySaveMode) AdvertiseSettings.ADVERTISE_MODE_BALANCED
                    else AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY
                )
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
            startGattServer(ctx)
            advertiser?.startAdvertising(settings, data, scanResponse, advertiseCallback)
            true
        } catch (error: Throwable) {
            reportError("BLE advertising failed", error)
            false
        }
    }

    @JvmStatic
    fun stopAdvertising(ctx: Context) {
        advertisingRequested = false
        stopAdvertisingInternal()
    }

    private fun stopAdvertisingInternal() {
        try { advertiser?.stopAdvertising(advertiseCallback) } catch (_: Throwable) {}
        // Do not tear down gattServer here — an active connection may still be
        // using it as the GATT client peer. It is closed only when all peers
        // disconnect in clearAddressState.
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartFailure(errorCode: Int) {
            safeBleError("Advertise start failed: $errorCode")
        }
    }

    private val gattServerCallback = object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            try {
                if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
                    serverConnectedDevices[device.address] = device
                    negotiatedMtu[device.address] = BleFrameCodec.DEFAULT_MTU
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                    serverConnectedDevices.remove(device.address)
                    handleDisconnect(device.address)
                }
            } catch (error: Throwable) {
                reportError("GATT server state callback failed", error)
            }
        }

        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
            // Server-side MTU for notifications.
            negotiatedMtu[device.address] = mtu.coerceIn(BleFrameCodec.DEFAULT_MTU, BleFrameCodec.MAX_MTU)
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
                    characteristic.uuid != MESSAGE_CHAR_UUID || preparedWrite -> BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED
                    offset != 0 -> BluetoothGatt.GATT_INVALID_OFFSET
                    value.size > BleFrameCodec.HEADER_SIZE + BleFrameCodec.maxPayloadForMtu(BleFrameCodec.MAX_MTU) ->
                        BluetoothGatt.GATT_INVALID_ATTRIBUTE_LENGTH
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
                        device, requestId,
                        if (valid) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED,
                        0, null
                    )
                } catch (_: Throwable) {}
            }
            if (valid) {
                try { NativeBridge.onPeerConnected(device.address) } catch (error: Throwable) {
                    reportError("Peer connected callback failed", error)
                }
            }
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            completeFrame(device.address, status == BluetoothGatt.GATT_SUCCESS)
        }
    }

    private fun startGattServer(ctx: Context) {
        try {
            if (!canBle(ctx)) return
            if (gattServer != null) return
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
        } catch (error: Throwable) {
            try { gattServer?.close() } catch (_: Throwable) {}
            gattServer = null
            reportError("GATT server startup failed", error)
        }
    }

    @JvmStatic
    fun startScanning(ctx: Context): Boolean {
        scanningRequested = true
        return try {
            appContext = ctx.applicationContext
            if (!canBle(ctx)) return false
            val currentAdapter = adapter ?: bluetoothManager?.adapter ?: return false
            if (!currentAdapter.isEnabled) return false
            scanner = currentAdapter.bluetoothLeScanner ?: return false
            try { scanner?.stopScan(scanCallback) } catch (_: Throwable) {}
            val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build()
            val settings = ScanSettings.Builder()
                .setScanMode(
                    if (batterySaveMode) ScanSettings.SCAN_MODE_LOW_POWER
                    else ScanSettings.SCAN_MODE_LOW_LATENCY
                )
                .build()
            scanner?.startScan(listOf(filter), settings, scanCallback)
            true
        } catch (error: Throwable) {
            reportError("BLE scanning failed", error)
            false
        }
    }

    @JvmStatic
    fun stopScanning(ctx: Context) {
        scanningRequested = false
        stopScanningInternal()
    }

    private fun stopScanningInternal() {
        try { scanner?.stopScan(scanCallback) } catch (error: Throwable) {
            reportError("Stopping BLE scan failed", error)
        }
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            try {
                val device = result.device ?: return
                val address = device.address
                val data = result.scanRecord?.getServiceData(ParcelUuid(SERVICE_UUID)) ?: return
                val shortId = String(data, Charsets.US_ASCII).uppercase()
                if (shortId.length != 8 || !shortId.all { it in '0'..'9' || it in 'A'..'F' }) return

                // Discovered is NOT connected. Authentication/handshake happens
                // in the signed presence exchange after GATT connects.
                peerShortIds.putIfAbsent(shortId, address)
                discoveredDevices[address] = device
                NativeBridge.onPeerDiscovered(address, shortId, "Kontakt ($shortId)", result.rssi)
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
            if (connectedGatts.containsKey(deviceAddress) ||
                serverConnectedDevices.containsKey(deviceAddress)) return true
            if (!connectingAddresses.add(deviceAddress)) return true
            val currentAdapter = adapter ?: bluetoothManager?.adapter ?: run {
                connectingAddresses.remove(deviceAddress)
                return false
            }
            val device = discoveredDevices[deviceAddress] ?: currentAdapter.getRemoteDevice(deviceAddress)
            val gatt = device.connectGatt(ctx, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
            if (gatt == null) {
                connectingAddresses.remove(deviceAddress)
                scheduleReconnect(ctx, deviceAddress)
                false
            } else {
                armConnectTimeout(ctx, deviceAddress)
                true
            }
        } catch (error: Throwable) {
            connectingAddresses.remove(deviceAddress)
            reportError("GATT connect failed", error)
            scheduleReconnect(ctx, deviceAddress)
            false
        }
    }

    private fun armConnectTimeout(ctx: Context, address: String) {
        connectTimeouts.remove(address)?.let { mainHandler.removeCallbacks(it) }
        val timeout = Runnable {
            if (connectingAddresses.remove(address)) {
                safeBleError("GATT connect timed out for $address")
                closeGattFor(address)
                scheduleReconnect(ctx, address)
            }
        }
        connectTimeouts[address] = timeout
        mainHandler.postDelayed(timeout, GATT_CONNECT_TIMEOUT_MS)
    }

    private fun scheduleReconnect(ctx: Context, address: String) {
        if (!scanningRequested && !advertisingRequested) return
        val attempts = reconnectAttempts.merge(address, 1) { a, _ -> a + 1 } ?: 1
        if (attempts > MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts.remove(address)
            return
        }
        val delay = RECONNECT_DELAY_MS * (1L shl (attempts - 1).coerceAtMost(4))
        mainHandler.postDelayed({
            try { connectToPeer(ctx, address) } catch (_: Throwable) {}
        }, delay)
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            val address = gatt.device.address
            try {
                connectTimeouts.remove(address)?.let { mainHandler.removeCallbacks(it) }
                connectingAddresses.remove(address)
                if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
                    connectedGatts[address] = gatt
                    negotiatedMtu[address] = BleFrameCodec.DEFAULT_MTU
                    reconnectAttempts.remove(address)
                    // Request a larger MTU; onMtuChanged then discovers services.
                    if (!gatt.requestMtu(BleFrameCodec.MAX_MTU)) {
                        gatt.discoverServices()
                    }
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                    connectedGatts.remove(address, gatt)
                    handleDisconnect(address)
                    try { gatt.close() } catch (_: Throwable) {}
                    appContext?.let { scheduleReconnect(it, address) }
                }
            } catch (error: Throwable) {
                connectingAddresses.remove(address)
                reportError("GATT state callback failed", error)
            }
        }

        @Deprecated("Used in deprecated flow below; kept for older devices")
        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            val safeMtu = mtu.coerceIn(BleFrameCodec.DEFAULT_MTU, BleFrameCodec.MAX_MTU)
            negotiatedMtu[gatt.device.address] = safeMtu
            try { gatt.discoverServices() } catch (error: Throwable) {
                reportError("GATT service discovery start failed", error)
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                enableNotifications(gatt)
            } else {
                safeBleError("Service discovery failed: $status for ${gatt.device.address}")
            }
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            if (descriptor.uuid == CCCD_UUID && status == BluetoothGatt.GATT_SUCCESS) {
                try { NativeBridge.onPeerConnected(gatt.device.address) } catch (error: Throwable) {
                    reportError("Peer connected callback failed", error)
                }
            } else if (descriptor.uuid == CCCD_UUID) {
                safeBleError("CCCD write failed: $status for ${gatt.device.address}")
            }
        }

        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int
        ) {
            if (characteristic.uuid == MESSAGE_CHAR_UUID) {
                completeFrame(gatt.device.address, status == BluetoothGatt.GATT_SUCCESS)
            }
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (characteristic.uuid == MESSAGE_CHAR_UUID) {
                handleReceivedBytes(gatt.device.address, characteristic.value ?: return)
            }
        }
    }

    /**
     * Queue a signed mesh envelope. [meshMsgId] is the full mesh UUID; the
     * 16-bit BLE link id is allocated here and only meaningful for the lifetime
     * of this transfer.
     */
    @JvmStatic
    fun sendMessage(ctx: Context, deviceAddress: String, text: String): Boolean =
        sendMessage(ctx, deviceAddress, text, null)

    @JvmStatic
    fun sendMessage(ctx: Context, deviceAddress: String, text: String, meshMsgId: String?): Boolean {
        return try {
            appContext = ctx.applicationContext
            if (!canBle(ctx)) return false
            val bytes = text.toByteArray(Charsets.UTF_8)
            if (bytes.isEmpty()) return false
            val mtu = negotiatedMtu[deviceAddress] ?: BleFrameCodec.DEFAULT_MTU
            if (bytes.size > BleFrameCodec.maxMessageBytes(mtu)) return false

            val hasRoute = serverConnectedDevices.containsKey(deviceAddress) ||
                connectedGatts.containsKey(deviceAddress)
            if (!hasRoute) {
                // No GATT yet — try to connect; caller (Rust outbox) will retry
                // once onPeerConnected fires flush_outbox. Report failure for
                // THIS attempt so the outbox backoff (not a crash) handles it.
                connectToPeer(ctx, deviceAddress)
                if (meshMsgId != null) {
                    NativeBridge.onTransportFailed(meshMsgId, "Brak trasy GATT; laczenie")
                }
                return false
            }

            val linkId = allocateLinkMessageId()
            val encodedFrames = BleFrameCodec.encode(bytes, linkId, mtu)
            if (encodedFrames.isEmpty()) return false

            val message = TxMessage(
                meshMsgId = meshMsgId ?: linkId.toString(16),
                frames = encodedFrames
            )
            val queue = txQueues.computeIfAbsent(deviceAddress) { ArrayDeque() }
            synchronized(queue) {
                // Backpressure: cap queued frames per link to protect RAM from a
                // relay flood. Newer traffic is refused (Rust outbox retries).
                val queuedFrames = queue.sumOf { it.frames.size - it.frameIndex }
                if (queuedFrames + encodedFrames.size > 2_048) {
                    if (meshMsgId != null) {
                        NativeBridge.onTransportFailed(meshMsgId, "Kolejka BLE przeladowana")
                    }
                    return false
                }
                queue.addLast(message)
            }
            drainWriteQueue(deviceAddress)
            true
        } catch (error: Throwable) {
            reportError("Queueing BLE message failed", error)
            if (meshMsgId != null) {
                NativeBridge.onTransportFailed(meshMsgId, "Blad kolejkowania BLE")
            }
            false
        }
    }

    private fun drainWriteQueue(address: String) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post { drainWriteQueue(address) }
            return
        }
        if (!txInFlight.add(address)) return
        val queue = txQueues[address]
        val message = queue?.let {
            synchronized(it) {
                val current = it.peekFirst() ?: return@synchronized null
                if (current.frameIndex >= current.frames.size) {
                    it.pollFirst()
                    return@synchronized it.peekFirst()
                }
                current
            }
        }
        if (message == null || queue == null) {
            txInFlight.remove(address)
            if (queue != null) txQueues.remove(address, queue)
            return
        }

        val frame = message.frames[message.frameIndex]
        val started = serverConnectedDevices[address]?.let { startServerNotification(it, frame) }
            ?: connectedGatts[address]?.let { startClientWrite(it, frame) }
            ?: false
        if (started) {
            val timeout = Runnable {
                if (txInFlight.remove(address)) {
                    safeBleError("BLE frame write timed out for $address")
                    completeFrame(address, false)
                }
            }
            frameTimeouts.put(address, timeout)?.let { mainHandler.removeCallbacks(it) }
            mainHandler.postDelayed(timeout, FRAME_WRITE_TIMEOUT_MS)
        } else {
            completeFrame(address, false)
        }
    }

    private fun completeFrame(address: String, success: Boolean) {
        mainHandler.post {
            frameTimeouts.remove(address)?.let { mainHandler.removeCallbacks(it) }
            val queue = txQueues[address]
            var messageFinished = false
            var finishedMsgId: String? = null
            var failedMsgId: String? = null
            var shouldRetry = false

            if (queue != null) {
                synchronized(queue) {
                    val current = queue.peekFirst()
                    if (current != null) {
                        if (success) {
                            current.frameIndex += 1
                            if (current.frameIndex >= current.frames.size) {
                                queue.pollFirst()
                                current.completed = true
                                messageFinished = true
                                finishedMsgId = current.meshMsgId
                            }
                        } else {
                            current.attempts += 1
                            if (current.attempts >= MAX_WRITE_ATTEMPTS) {
                                queue.pollFirst()
                                failedMsgId = current.meshMsgId
                            } else {
                                // Restart this multi-frame message from the top.
                                current.frameIndex = 0
                                shouldRetry = true
                            }
                        }
                    }
                    if (queue.isEmpty()) txQueues.remove(address, queue)
                }
            }
            txInFlight.remove(address)

            // Fire transport callbacks OUTSIDE the queue lock.
            if (messageFinished && finishedMsgId != null) {
                NativeBridge.onTransportSent(finishedMsgId!!)
            }
            if (failedMsgId != null) {
                NativeBridge.onTransportFailed(failedMsgId!!, "Zapis GATT nie powiodl sie po $MAX_WRITE_ATTEMPTS probach")
            }
            mainHandler.postDelayed({ drainWriteQueue(address) }, if (shouldRetry) 150L else 5L)
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
            reportError("Enabling GATT notifications failed", error)
        }
    }

    private fun handleDisconnect(address: String) {
        // Tear down in-flight transfers for this link; the Rust outbox retries.
        rxBuffers.keys.removeIf { it.address == address }
        negotiatedMtu.remove(address)
        frameTimeouts.remove(address)?.let { mainHandler.removeCallbacks(it) }
        connectTimeouts.remove(address)?.let { mainHandler.removeCallbacks(it) }
        val queue = txQueues.remove(address)
        if (queue != null) {
            synchronized(queue) {
                val pending = queue.filter { !it.completed }
                for (msg in pending) {
                    NativeBridge.onTransportFailed(msg.meshMsgId, "Rozlaczono GATT w trakcie transmisji")
                }
                queue.clear()
            }
        }
        txInFlight.remove(address)
        NativeBridge.onPeerDisconnected(address)
        // Tear down the server if nobody is connected to either role.
        if (serverConnectedDevices.isEmpty() && connectedGatts.isEmpty()) {
            try { gattServer?.close() } catch (_: Throwable) {}
            gattServer = null
        }
    }

    private fun closeGattFor(address: String) {
        connectedGatts.remove(address)?.let { gatt ->
            try { gatt.close() } catch (_: Throwable) {}
        }
    }

    private fun safeBleError(message: String) {
        try { NativeBridge.onBleError(message) } catch (_: Throwable) {}
    }

    private fun reportError(prefix: String, error: Throwable) {
        android.util.Log.w("VoidBleManager", "$prefix: ${error.message}", error)
        safeBleError("$prefix: ${error.message ?: error.javaClass.simpleName}")
    }
}
