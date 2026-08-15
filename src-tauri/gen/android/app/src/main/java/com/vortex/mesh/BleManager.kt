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
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

object BleManager {
    val SERVICE_UUID: UUID = UUID.fromString("5f9b34fb-9b4a-4a0c-8b48-4b0e3c1b6b01")
    val MESSAGE_CHAR_UUID: UUID = UUID.fromString("5f9b34fb-9b4a-4a0c-8b48-4b0e3c1b6b02")
    private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    private const val FRAME_MARKER: Byte = 0x00
    private const val CHUNK_SIZE = 16
    private const val FRAME_HEADER_SIZE = 5
    private const val MAX_CHUNKS = 255
    private const val RX_BUFFER_TIMEOUT_MS = 30_000L
    private const val CLEANUP_INTERVAL_MS = 10_000L

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

    private val nextMessageId = AtomicInteger(0)
    private val cleanupHandler = Handler(Looper.getMainLooper())
    private val cleanupRunnable = object : Runnable {
        override fun run() {
            cleanupStaleBuffers()
            cleanupHandler.postDelayed(this, CLEANUP_INTERVAL_MS)
        }
    }

    private var localNodeId: String = ""
    private var localName: String = "Vortex"

    @JvmStatic fun getLocalNodeId(): String = localNodeId
    @JvmStatic fun getLocalName(): String = localName

    private fun startCleanupLoop() {
        cleanupHandler.removeCallbacks(cleanupRunnable)
        cleanupHandler.post(cleanupRunnable)
    }

    private fun cleanupStaleBuffers() {
        val cutoff = System.currentTimeMillis() - RX_BUFFER_TIMEOUT_MS
        rxBuffers.entries.removeIf { it.value.lastUpdate < cutoff }
    }

    private fun allocateMessageId(): Int = nextMessageId.getAndUpdate { (it + 1) and 0xFFFF } and 0xFFFF

    private fun hasPermission(ctx: Context, perm: String): Boolean =
        ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED

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
            localName = name
            bluetoothManager = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
            adapter = bluetoothManager?.adapter
            startCleanupLoop()
        } catch (e: Throwable) {
            bluetoothManager = null
            adapter = null
        }
    }

    @JvmStatic
    fun ensureInit(ctx: Context) {
        try {
            if (appContext == null) appContext = ctx.applicationContext
            if (bluetoothManager == null || adapter == null) {
                bluetoothManager = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
                adapter = bluetoothManager?.adapter
            }
            startCleanupLoop()
        } catch (e: Throwable) {}
    }

    @JvmStatic
    private fun handleReceivedBytes(address: String, bytes: ByteArray) {
        try {
            if (bytes.isNotEmpty() && bytes[0] == FRAME_MARKER) {
                if (bytes.size < FRAME_HEADER_SIZE) return
                val msgId = ((bytes[1].toInt() and 0xFF) shl 8) or (bytes[2].toInt() and 0xFF)
                val totalChunks = bytes[3].toInt() and 0xFF
                val chunkIndex = bytes[4].toInt() and 0xFF
                if (totalChunks <= 0 || totalChunks > MAX_CHUNKS || chunkIndex >= totalChunks) return
                val payload = bytes.copyOfRange(FRAME_HEADER_SIZE, bytes.size)
                if (payload.isEmpty() || payload.size > CHUNK_SIZE) return

                val key = ChunkKey(address, msgId)
                val buffer = rxBuffers.compute(key) { _, existing ->
                    if (existing == null || existing.totalChunks != totalChunks) ChunkBuffer(totalChunks) else existing
                } ?: return

                synchronized(buffer) {
                    buffer.chunks[chunkIndex] = payload
                    buffer.lastUpdate = System.currentTimeMillis()
                    if (buffer.chunks.size == buffer.totalChunks && (0 until buffer.totalChunks).all { buffer.chunks.containsKey(it) }) {
                        val outStream = ByteArrayOutputStream()
                        for (i in 0 until buffer.totalChunks) outStream.write(buffer.chunks[i]!!)
                        rxBuffers.remove(key, buffer)
                        NativeBridge.onMessageReceived(address, String(outStream.toByteArray(), Charsets.UTF_8))
                    }
                }
            } else {
                NativeBridge.onMessageReceived(address, String(bytes, Charsets.UTF_8))
            }
        } catch (e: Throwable) {}
    }

    @JvmStatic
    fun startAdvertising(ctx: Context): Boolean {
        return try {
            appContext = ctx.applicationContext
            startCleanupLoop()
            if (!canBle(ctx)) return false
            val currentAdapter = adapter ?: bluetoothManager?.adapter ?: return false
            if (!currentAdapter.isEnabled) return false
            advertiser = currentAdapter.bluetoothLeAdvertiser ?: return false
            val settings = AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
                .setConnectable(true)
                .build()
            val data = AdvertiseData.Builder().setIncludeDeviceName(false).addServiceUuid(ParcelUuid(SERVICE_UUID)).build()
            val shortTag = localNodeId.takeLast(8)
            val scanResponse = AdvertiseData.Builder().setIncludeDeviceName(false)
                .addServiceData(ParcelUuid(SERVICE_UUID), shortTag.toByteArray(Charsets.UTF_8)).build()
            advertiser?.startAdvertising(settings, data, scanResponse, advertiseCallback)
            startGattServer(ctx)
            true
        } catch (e: Throwable) { false }
    }

    @JvmStatic
    fun stopAdvertising(ctx: Context) {
        try {
            if (!canBle(ctx)) return
            advertiser?.stopAdvertising(advertiseCallback)
            gattServer?.close()
            gattServer = null
        } catch (e: Throwable) {}
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartFailure(errorCode: Int) { try { NativeBridge.onBleError("Advertise start failed: $errorCode") } catch (e: Throwable) {} }
    }

    private fun startGattServer(ctx: Context) {
        try {
            if (!canBle(ctx)) return
            gattServer = bluetoothManager?.openGattServer(ctx, object : BluetoothGattServerCallback() {
                override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
                    try {
                        if (newState == BluetoothProfile.STATE_CONNECTED) serverConnectedDevices[device.address] = device
                        else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                            serverConnectedDevices.remove(device.address)
                            rxBuffers.keys.removeIf { it.address == device.address }
                            NativeBridge.onPeerDisconnected(device.address)
                        }
                    } catch (e: Throwable) {}
                }
                override fun onCharacteristicWriteRequest(device: BluetoothDevice, requestId: Int, characteristic: BluetoothGattCharacteristic, preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray) {
                    try {
                        if (characteristic.uuid == MESSAGE_CHAR_UUID && !preparedWrite && offset == 0) handleReceivedBytes(device.address, value)
                        if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
                    } catch (e: Throwable) {}
                }
                override fun onDescriptorWriteRequest(device: BluetoothDevice, requestId: Int, descriptor: BluetoothGattDescriptor, preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray) {
                    try {
                        if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
                        if (descriptor.uuid == CCCD_UUID) NativeBridge.onPeerConnected(device.address)
                    } catch (e: Throwable) {}
                }
            })
            val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
            val messageChar = BluetoothGattCharacteristic(MESSAGE_CHAR_UUID, BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_NOTIFY, BluetoothGattCharacteristic.PERMISSION_WRITE)
            val cccd = BluetoothGattDescriptor(CCCD_UUID, BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE)
            messageChar.addDescriptor(cccd)
            service.addCharacteristic(messageChar)
            gattServer?.addService(service)
        } catch (e: Throwable) { gattServer = null }
    }

    @JvmStatic
    fun startScanning(ctx: Context): Boolean {
        return try {
            appContext = ctx.applicationContext
            if (!canBle(ctx)) return false
            val currentAdapter = adapter ?: bluetoothManager?.adapter ?: return false
            if (!currentAdapter.isEnabled) return false
            scanner = currentAdapter.bluetoothLeScanner ?: return false
            val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build()
            val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
            scanner?.startScan(listOf(filter), settings, scanCallback)
            true
        } catch (e: Throwable) { false }
    }

    @JvmStatic
    fun stopScanning(ctx: Context) { try { if (canBle(ctx)) scanner?.stopScan(scanCallback) } catch (e: Throwable) {} }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            try {
                val device = result.device ?: return
                val address = device.address
                val data = result.scanRecord?.getServiceData(ParcelUuid(SERVICE_UUID)) ?: return
                val shortId = String(data, Charsets.UTF_8)
                if (shortId.length <= 13) {
                    val oldAddress = peerShortIds[shortId]
                    if (oldAddress != null && oldAddress != address) {
                        discoveredDevices.remove(oldAddress)
                        connectedGatts.remove(oldAddress)?.let { try { it.close() } catch (e: Throwable) {} }
                        serverConnectedDevices.remove(oldAddress)
                        connectingAddresses.remove(oldAddress)
                        rxBuffers.keys.removeIf { it.address == oldAddress }
                        NativeBridge.onPeerDisconnected(oldAddress)
                    }
                    peerShortIds[shortId] = address
                    discoveredDevices[address] = device
                    NativeBridge.onPeerDiscovered(address, shortId, "Kontakt ($shortId)", result.rssi)
                }
                appContext?.let { currentContext ->
                    if (!connectedGatts.containsKey(address) && !serverConnectedDevices.containsKey(address) && !connectingAddresses.contains(address)) connectToPeer(currentContext, address)
                }
            } catch (e: Throwable) {}
        }
        override fun onScanFailed(errorCode: Int) { try { NativeBridge.onBleError("Scan failed: $errorCode") } catch (e: Throwable) {} }
    }

    @JvmStatic fun connectToPeer(address: String): Boolean = appContext?.let { connectToPeer(it, address) } ?: false

    @JvmStatic
    fun connectToPeer(ctx: Context, deviceAddress: String): Boolean {
        return try {
            appContext = ctx.applicationContext
            if (!canBle(ctx)) return false
            if (connectedGatts.containsKey(deviceAddress) || serverConnectedDevices.containsKey(deviceAddress)) return true
            if (connectingAddresses.contains(deviceAddress)) return true
            val currentAdapter = adapter ?: bluetoothManager?.adapter ?: return false
            val device = discoveredDevices[deviceAddress] ?: currentAdapter.getRemoteDevice(deviceAddress)
            connectingAddresses.add(deviceAddress)
            val gatt = device.connectGatt(ctx, false, gattCallback)
            if (gatt == null) { connectingAddresses.remove(deviceAddress); return false }
            true
        } catch (e: Throwable) { connectingAddresses.remove(deviceAddress); false }
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            val address = g.device.address
            try {
                connectingAddresses.remove(address)
                if (newState == BluetoothProfile.STATE_CONNECTED) { connectedGatts[address] = g; g.requestMtu(512) }
                else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    connectedGatts.remove(address)
                    rxBuffers.keys.removeIf { it.address == address }
                    NativeBridge.onPeerDisconnected(address)
                    try { g.close() } catch (e: Throwable) {}
                }
            } catch (e: Throwable) { connectingAddresses.remove(address) }
        }
        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) { try { g.discoverServices() } catch (e: Throwable) {} }
        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) { try { if (status == BluetoothGatt.GATT_SUCCESS) enableNotifications(g) } catch (e: Throwable) {} }
        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            try { if (descriptor.uuid == CCCD_UUID && status == BluetoothGatt.GATT_SUCCESS) NativeBridge.onPeerConnected(g.device.address) } catch (e: Throwable) {}
        }
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            try { if (characteristic.uuid == MESSAGE_CHAR_UUID) handleReceivedBytes(g.device.address, characteristic.value ?: return) } catch (e: Throwable) {}
        }
    }

    @JvmStatic
    fun sendMessage(ctx: Context, deviceAddress: String, text: String): Boolean {
        return try {
            appContext = ctx.applicationContext
            if (!canBle(ctx)) return false
            val bytes = text.toByteArray(Charsets.UTF_8)
            val serverDevice = serverConnectedDevices[deviceAddress]
            val clientGatt = connectedGatts[deviceAddress]
            if (serverDevice == null && clientGatt == null) { connectToPeer(ctx, deviceAddress); return false }
            if (bytes.size <= CHUNK_SIZE) {
                if (serverDevice != null) writeToServerDevice(serverDevice, bytes) else clientGatt?.let { writeToClientGatt(it, bytes) }
                return true
            }
            val totalChunks = (bytes.size + CHUNK_SIZE - 1) / CHUNK_SIZE
            if (totalChunks > MAX_CHUNKS) return false
            val handler = Handler(Looper.getMainLooper())
            val msgId = allocateMessageId()
            var delayMs = 0L
            for (i in 0 until totalChunks) {
                val start = i * CHUNK_SIZE
                val end = minOf(start + CHUNK_SIZE, bytes.size)
                val payload = bytes.copyOfRange(start, end)
                val chunk = ByteArray(FRAME_HEADER_SIZE + payload.size)
                chunk[0] = FRAME_MARKER
                chunk[1] = (msgId ushr 8).toByte()
                chunk[2] = msgId.toByte()
                chunk[3] = totalChunks.toByte()
                chunk[4] = i.toByte()
                System.arraycopy(payload, 0, chunk, FRAME_HEADER_SIZE, payload.size)
                handler.postDelayed({ if (serverDevice != null) writeToServerDevice(serverDevice, chunk) else clientGatt?.let { writeToClientGatt(it, chunk) } }, delayMs)
                delayMs += 35L
            }
            true
        } catch (e: Throwable) { false }
    }

    private fun writeToServerDevice(device: BluetoothDevice, bytes: ByteArray) {
        try {
            val service = gattServer?.getService(SERVICE_UUID) ?: return
            val char = service.getCharacteristic(MESSAGE_CHAR_UUID) ?: return
            if (Build.VERSION.SDK_INT >= 33) gattServer?.notifyCharacteristicChanged(device, char, false, bytes)
            else { @Suppress("DEPRECATION") char.value = bytes; @Suppress("DEPRECATION") gattServer?.notifyCharacteristicChanged(device, char, false) }
        } catch (e: Throwable) {}
    }

    private fun writeToClientGatt(gatt: BluetoothGatt, bytes: ByteArray) {
        try {
            val service = gatt.getService(SERVICE_UUID) ?: return
            val char = service.getCharacteristic(MESSAGE_CHAR_UUID) ?: return
            if (Build.VERSION.SDK_INT >= 33) gatt.writeCharacteristic(char, bytes, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)
            else { @Suppress("DEPRECATION") char.value = bytes; @Suppress("DEPRECATION") gatt.writeCharacteristic(char) }
        } catch (e: Throwable) {}
    }

    private fun enableNotifications(gatt: BluetoothGatt) {
        try {
            val service = gatt.getService(SERVICE_UUID) ?: return
            val char = service.getCharacteristic(MESSAGE_CHAR_UUID) ?: return
            gatt.setCharacteristicNotification(char, true)
            val cccd = char.getDescriptor(CCCD_UUID) ?: return
            if (Build.VERSION.SDK_INT >= 33) gatt.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            else { @Suppress("DEPRECATION") cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE; @Suppress("DEPRECATION") gatt.writeDescriptor(cccd) }
        } catch (e: Throwable) {}
    }
}
