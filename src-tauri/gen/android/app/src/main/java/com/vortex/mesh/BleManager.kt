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

object BleManager {
    val SERVICE_UUID: UUID = UUID.fromString("5f9b34fb-9b4a-4a0c-8b48-4b0e3c1b6b01")
    val MESSAGE_CHAR_UUID: UUID = UUID.fromString("5f9b34fb-9b4a-4a0c-8b48-4b0e3c1b6b02")
    private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    private const val CHUNK_SIZE = BleFrameCodec.CHUNK_SIZE
    private const val FRAME_HEADER_SIZE = BleFrameCodec.HEADER_SIZE
    private const val MAX_MESSAGE_BYTES = BleFrameCodec.MAX_MESSAGE_BYTES
    private const val MAX_RX_BUFFERS = 128
    private const val MAX_RX_BUFFERS_PER_DEVICE = 16
    private const val RX_BUFFER_TIMEOUT_MS = 30_000L
    private const val CLEANUP_INTERVAL_MS = 10_000L
    private const val MAX_WRITE_ATTEMPTS = 3

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

    private data class ChunkKey(val address: String, val msgId: Int)
    private class ChunkBuffer(val totalChunks: Int) {
        val chunks = mutableMapOf<Int, ByteArray>()
        @Volatile var lastUpdate: Long = System.currentTimeMillis()
    }
    private val rxBuffers = ConcurrentHashMap<ChunkKey, ChunkBuffer>()

    private data class PendingFrame(val bytes: ByteArray, var attempts: Int = 0)
    private val writeQueues = ConcurrentHashMap<String, ArrayDeque<PendingFrame>>()
    private val writesInFlight = ConcurrentHashMap.newKeySet<String>()
    private val writeTimeouts = ConcurrentHashMap<String, Runnable>()

    private val nextMessageId = AtomicInteger(0)
    private val mainHandler = Handler(Looper.getMainLooper())
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
            if (hidden) {
                stopAdvertisingInternal()
            } else if (advertisingRequested) {
                startAdvertising(ctx)
            }
        }
        if (batteryChanged && scanningRequested) {
            stopScanningInternal()
            startScanning(ctx)
        }
    }

    @JvmStatic
    private fun handleReceivedBytes(address: String, bytes: ByteArray) {
        try {
            // Protocol v2 accepts framed traffic only.
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
                    if (message.size <= MAX_MESSAGE_BYTES) {
                        NativeBridge.onMessageReceived(address, String(message, Charsets.UTF_8))
                    }
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
        try { gattServer?.close() } catch (_: Throwable) {}
        gattServer = null
        serverConnectedDevices.clear()
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
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                    serverConnectedDevices.remove(device.address)
                    clearAddressState(device.address)
                    NativeBridge.onPeerDisconnected(device.address)
                }
            } catch (error: Throwable) {
                reportError("GATT server state callback failed", error)
            }
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
                    value.size !in (FRAME_HEADER_SIZE..(FRAME_HEADER_SIZE + CHUNK_SIZE)) -> BluetoothGatt.GATT_INVALID_ATTRIBUTE_LENGTH
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
                try { NativeBridge.onPeerConnected(device.address) } catch (error: Throwable) {
                    reportError("Peer connected callback failed", error)
                }
            }
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            completeWrite(device.address, status == BluetoothGatt.GATT_SUCCESS)
        }
    }

    private fun startGattServer(ctx: Context) {
        try {
            if (!canBle(ctx)) return
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
        try {
            scanner?.stopScan(scanCallback)
        } catch (error: Throwable) {
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

                // Do not disconnect an existing device solely because another
                // advertiser claims the same short ID. Authentication happens
                // later in the signed protocol-v2 presence envelope.
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
            if (connectedGatts.containsKey(deviceAddress) || serverConnectedDevices.containsKey(deviceAddress)) return true
            if (!connectingAddresses.add(deviceAddress)) return true
            val currentAdapter = adapter ?: bluetoothManager?.adapter ?: run {
                connectingAddresses.remove(deviceAddress)
                return false
            }
            val device = discoveredDevices[deviceAddress] ?: currentAdapter.getRemoteDevice(deviceAddress)
            val gatt = device.connectGatt(ctx, false, gattCallback)
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
            try {
                connectingAddresses.remove(address)
                if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
                    connectedGatts[address] = gatt
                    if (!gatt.requestMtu(512)) gatt.discoverServices()
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                    connectedGatts.remove(address, gatt)
                    clearAddressState(address)
                    NativeBridge.onPeerDisconnected(address)
                    try { gatt.close() } catch (_: Throwable) {}
                }
            } catch (error: Throwable) {
                connectingAddresses.remove(address)
                reportError("GATT state callback failed", error)
            }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            try { gatt.discoverServices() } catch (error: Throwable) {
                reportError("GATT service discovery start failed", error)
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                enableNotifications(gatt)
            } else {
                safeBleError("Service discovery failed: $status")
            }
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            if (descriptor.uuid == CCCD_UUID && status == BluetoothGatt.GATT_SUCCESS) {
                try { NativeBridge.onPeerConnected(gatt.device.address) } catch (error: Throwable) {
                    reportError("Peer connected callback failed", error)
                }
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
                completeWrite(gatt.device.address, status == BluetoothGatt.GATT_SUCCESS)
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
    fun sendMessage(ctx: Context, deviceAddress: String, text: String): Boolean {
        return try {
            appContext = ctx.applicationContext
            if (!canBle(ctx)) return false
            val bytes = text.toByteArray(Charsets.UTF_8)
            if (bytes.isEmpty() || bytes.size > MAX_MESSAGE_BYTES) return false
            if (!serverConnectedDevices.containsKey(deviceAddress) && !connectedGatts.containsKey(deviceAddress)) {
                connectToPeer(ctx, deviceAddress)
                return false
            }

            val encodedFrames = BleFrameCodec.encode(bytes, allocateMessageId())
            if (encodedFrames.isEmpty()) return false
            val frames = encodedFrames.mapTo(ArrayList(encodedFrames.size)) { frame ->
                PendingFrame(frame)
            }

            val queue = writeQueues.computeIfAbsent(deviceAddress) { ArrayDeque() }
            synchronized(queue) {
                // Backpressure protects RAM when a slow GATT link receives a
                // burst of relayed packets.
                if (queue.size + frames.size > 2_048) return false
                frames.forEach { frame -> queue.addLast(frame) }
            }
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
        if (!writesInFlight.add(address)) return
        val queue = writeQueues[address]
        val pending = queue?.let { synchronized(it) { it.peekFirst() } }
        if (pending == null) {
            writesInFlight.remove(address)
            if (queue != null) writeQueues.remove(address, queue)
            return
        }

        val started = serverConnectedDevices[address]?.let { startServerNotification(it, pending.bytes) }
            ?: connectedGatts[address]?.let { startClientWrite(it, pending.bytes) }
            ?: false
        if (started) {
            val timeout = Runnable {
                if (writesInFlight.remove(address)) {
                    writeQueues.remove(address)
                    writeTimeouts.remove(address)
                    safeBleError("BLE write timed out for $address")
                }
            }
            writeTimeouts.put(address, timeout)?.let { callback -> mainHandler.removeCallbacks(callback) }
            mainHandler.postDelayed(timeout, 5_000L)
        } else {
            completeWrite(address, false)
        }
    }

    private fun completeWrite(address: String, success: Boolean) {
        mainHandler.post {
            writeTimeouts.remove(address)?.let { callback -> mainHandler.removeCallbacks(callback) }
            val queue = writeQueues[address]
            val pending = queue?.let { synchronized(it) { it.peekFirst() } }
            var retry = false
            if (queue != null && pending != null) {
                synchronized(queue) {
                    if (success) {
                        queue.pollFirst()
                    } else {
                        pending.attempts += 1
                        if (pending.attempts >= MAX_WRITE_ATTEMPTS) {
                            // The receiver cannot reassemble a message with a
                            // missing frame. Abort queued traffic for this link
                            // and let the message-level ACK timeout report failure.
                            queue.clear()
                            safeBleError("BLE queue aborted after $MAX_WRITE_ATTEMPTS attempts for $address")
                        } else {
                            retry = true
                        }
                    }
                    if (queue.isEmpty()) writeQueues.remove(address, queue)
                }
            }
            writesInFlight.remove(address)
            mainHandler.postDelayed({ drainWriteQueue(address) }, if (retry) 100L else 5L)
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

    private fun clearAddressState(address: String) {
        rxBuffers.keys.removeIf { it.address == address }
        writeQueues.remove(address)
        writesInFlight.remove(address)
        writeTimeouts.remove(address)?.let { callback -> mainHandler.removeCallbacks(callback) }
        connectingAddresses.remove(address)
    }

    private fun safeBleError(message: String) {
        try { NativeBridge.onBleError(message) } catch (_: Throwable) {}
    }

    private fun reportError(prefix: String, error: Throwable) {
        android.util.Log.w("VoidBleManager", "$prefix: ${error.message}", error)
        safeBleError("$prefix: ${error.message ?: error.javaClass.simpleName}")
    }
}
