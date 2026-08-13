package com.vortex.mesh

import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelUuid
import androidx.core.content.ContextCompat
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import android.os.Handler
import android.os.Looper
import java.io.ByteArrayOutputStream

object BleManager {
    val SERVICE_UUID: UUID = UUID.fromString("5f9b34fb-9b4a-4a0c-8b48-4b0e3c1b6b01")
    val MESSAGE_CHAR_UUID: UUID = UUID.fromString("5f9b34fb-9b4a-4a0c-8b48-4b0e3c1b6b02")
    private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

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
    private val peerShortIds = ConcurrentHashMap<String, String>() // shortId -> latest MAC address
    private class ChunkBuffer {
        var totalChunks = 0
        val chunks = mutableMapOf<Int, ByteArray>()
        var lastUpdate = System.currentTimeMillis()
    }
    private val rxBuffers = ConcurrentHashMap<String, ChunkBuffer>()


    private var localNodeId: String = ""
    private var localName: String = "Vortex"

    @JvmStatic fun getLocalNodeId(): String = localNodeId
    @JvmStatic fun getLocalName(): String = localName

    private fun hasPermission(ctx: Context, perm: String): Boolean =
        ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED

    private fun canBle(ctx: Context): Boolean {
        return if (Build.VERSION.SDK_INT >= 31) {
            hasPermission(ctx, android.Manifest.permission.BLUETOOTH_SCAN) &&
            hasPermission(ctx, android.Manifest.permission.BLUETOOTH_ADVERTISE) &&
            hasPermission(ctx, android.Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            hasPermission(ctx, android.Manifest.permission.ACCESS_FINE_LOCATION)
        }
    }

    @JvmStatic
    fun init(ctx: Context, nodeId: String, name: String) {
        try {
            appContext = ctx.applicationContext
            localNodeId = nodeId
            localName = name
            bluetoothManager = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
            adapter = bluetoothManager?.adapter
        } catch (e: Throwable) {
            bluetoothManager = null
            adapter = null
        }
    }

    /** Called after permission grant to ensure BleManager has a context and adapter,
     *  without overwriting localNodeId/localName if already set by Rust via init(). */
    @JvmStatic
    fun ensureInit(ctx: Context) {
        try {
            if (appContext == null) {
                appContext = ctx.applicationContext
            }
            if (bluetoothManager == null || adapter == null) {
                bluetoothManager = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
                adapter = bluetoothManager?.adapter
            }
            // If nodeId is still empty (Rust hasn't called ble_init yet), leave it —
            // BLE advertising will just have an empty short ID until start_mesh runs.
        } catch (e: Throwable) {}
    }

    @JvmStatic
    
    private fun handleReceivedBytes(address: String, bytes: ByteArray) {
        try {
            if (bytes.isNotEmpty() && bytes[0] == 0x00.toByte()) {
                if (bytes.size < 4) return
                val msgId = bytes[1].toInt()
                val totalChunks = bytes[2].toInt() and 0xFF
                val chunkIndex = bytes[3].toInt() and 0xFF
                val payload = bytes.copyOfRange(4, bytes.size)

                val buffer = rxBuffers.getOrPut(address) { ChunkBuffer() }
                buffer.totalChunks = totalChunks
                buffer.chunks[chunkIndex] = payload
                buffer.lastUpdate = System.currentTimeMillis()

                if (buffer.chunks.size >= buffer.totalChunks) {
                    val outStream = ByteArrayOutputStream()
                    for (i in 0 until buffer.totalChunks) {
                        buffer.chunks[i]?.let { outStream.write(it) }
                    }
                    val fullText = String(outStream.toByteArray(), Charsets.UTF_8)
                    NativeBridge.onMessageReceived(address, fullText)
                    rxBuffers.remove(address)
                }
            } else {
                val text = String(bytes, Charsets.UTF_8)
                NativeBridge.onMessageReceived(address, text)
            }
        } catch (e: Throwable) {}
    }

    @JvmStatic
    fun startAdvertising(ctx: Context): Boolean {
        return try {
            appContext = ctx.applicationContext
            if (!canBle(ctx)) return false
            val currentAdapter = adapter ?: bluetoothManager?.adapter ?: return false
            if (!currentAdapter.isEnabled) return false

            advertiser = currentAdapter.bluetoothLeAdvertiser ?: return false

            val settings = AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
                .setConnectable(true)
                .build()

            // Standard BLE limits AdvertiseData to 31 bytes.
            // 128-bit UUID takes 18 bytes (header + UUID).
            val data = AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .addServiceUuid(ParcelUuid(SERVICE_UUID))
                .build()

            // Put the custom payload in the ScanResponse which gets its own 31-byte limit.
            // Using addServiceData with the 128-bit UUID consumes 18 bytes, leaving 13 bytes for the payload.
            // We only send the 8-character ID.
            val shortTag = localNodeId.takeLast(8)
            val scanResponse = AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .addServiceData(ParcelUuid(SERVICE_UUID), shortTag.toByteArray(Charsets.UTF_8))
                .build()

            advertiser?.startAdvertising(settings, data, scanResponse, advertiseCallback)
            startGattServer(ctx)
            true
        } catch (e: Throwable) {
            false
        }
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
        override fun onStartFailure(errorCode: Int) {
            try {
                NativeBridge.onBleError("Advertise start failed: $errorCode")
            } catch (e: Throwable) {}
        }
    }

    private fun startGattServer(ctx: Context) {
        try {
            if (!canBle(ctx)) return
            gattServer = bluetoothManager?.openGattServer(ctx, object : BluetoothGattServerCallback() {
                override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
                    try {
                        if (newState == BluetoothProfile.STATE_CONNECTED) {
                            serverConnectedDevices[device.address] = device
                            // NOTE: Do not call NativeBridge.onPeerConnected here yet!
                            // Wait for client to write to CCCD descriptor below so notifications actually work.
                        } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                            serverConnectedDevices.remove(device.address)
                            NativeBridge.onPeerDisconnected(device.address)
                        }
                    } catch (e: Throwable) {}
                }

                override fun onCharacteristicWriteRequest(
                    device: BluetoothDevice, requestId: Int, characteristic: BluetoothGattCharacteristic,
                    preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray
                ) {
                    try {
                        if (characteristic.uuid == MESSAGE_CHAR_UUID) {
                            handleReceivedBytes(device.address, value)
                        }
                        if (responseNeeded) {
                            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
                        }
                    } catch (e: Throwable) {}
                }

                override fun onDescriptorWriteRequest(
                    device: BluetoothDevice, requestId: Int, descriptor: BluetoothGattDescriptor,
                    preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray
                ) {
                    try {
                        if (responseNeeded) {
                            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
                        }
                        if (descriptor.uuid == CCCD_UUID) {
                            // Client has enabled notifications — now GATT is ready for server to send presence/messages!
                            NativeBridge.onPeerConnected(device.address)
                        }
                    } catch (e: Throwable) {}
                }
            })

            val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
            val messageChar = BluetoothGattCharacteristic(
                MESSAGE_CHAR_UUID,
                BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                BluetoothGattCharacteristic.PERMISSION_WRITE
            )
            val cccd = BluetoothGattDescriptor(
                CCCD_UUID,
                BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE
            )
            messageChar.addDescriptor(cccd)
            service.addCharacteristic(messageChar)
            gattServer?.addService(service)
        } catch (e: Throwable) {
            gattServer = null
        }
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
        } catch (e: Throwable) {
            false
        }
    }

    @JvmStatic
    fun stopScanning(ctx: Context) {
        try {
            if (!canBle(ctx)) return
            scanner?.stopScan(scanCallback)
        } catch (e: Throwable) {}
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            try {
                val device = result.device ?: return
                val address = device.address

                val data = result.scanRecord?.getServiceData(ParcelUuid(SERVICE_UUID)) ?: return
                val shortId = String(data, Charsets.UTF_8)
                if (shortId.length <= 13) {
                    // Check if this shortId was previously mapped to an older MAC address (BLE RPA rotation)
                    val oldAddress = peerShortIds[shortId]
                    if (oldAddress != null && oldAddress != address) {
                        discoveredDevices.remove(oldAddress)
                        connectedGatts.remove(oldAddress)?.let { oldGatt ->
                            try { oldGatt.close() } catch (e: Throwable) {}
                        }
                        serverConnectedDevices.remove(oldAddress)
                        connectingAddresses.remove(oldAddress)
                        NativeBridge.onPeerDisconnected(oldAddress)
                    }
                    peerShortIds[shortId] = address
                    discoveredDevices[address] = device

                    val name = "Kontakt ($shortId)"
                    NativeBridge.onPeerDiscovered(address, shortId, name, result.rssi)
                }

                appContext?.let { ctx ->
                    if (!connectedGatts.containsKey(address) &&
                        !serverConnectedDevices.containsKey(address) &&
                        !connectingAddresses.contains(address)) {
                        connectToPeer(ctx, address)
                    }
                }
            } catch (e: Throwable) {}
        }

        override fun onScanFailed(errorCode: Int) {
            try {
                NativeBridge.onBleError("Scan failed: $errorCode")
            } catch (e: Throwable) {}
        }
    }

    @JvmStatic
    fun connectToPeer(address: String): Boolean {
        val ctx = appContext ?: return false
        return connectToPeer(ctx, address)
    }

    @JvmStatic
    fun connectToPeer(ctx: Context, deviceAddress: String): Boolean {
        return try {
            appContext = ctx.applicationContext
            if (!canBle(ctx)) return false

            if (connectedGatts.containsKey(deviceAddress) || serverConnectedDevices.containsKey(deviceAddress)) {
                return true
            }

            if (connectingAddresses.contains(deviceAddress)) {
                return true
            }

            val currentAdapter = adapter ?: bluetoothManager?.adapter ?: return false
            val device = discoveredDevices[deviceAddress] ?: currentAdapter.getRemoteDevice(deviceAddress) ?: return false

            connectingAddresses.add(deviceAddress)

            val gatt = device.connectGatt(ctx, false, gattCallback)
            if (gatt == null) {
                connectingAddresses.remove(deviceAddress)
                return false
            }
            true
        } catch (e: Throwable) {
            connectingAddresses.remove(deviceAddress)
            false
        }
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            val address = g.device.address
            try {
                connectingAddresses.remove(address)
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    connectedGatts[address] = g
                    // Request Maximum Transmission Unit (MTU) of 512 bytes for large presence packets.
                    // discoverServices() will be called in onMtuChanged callback.
                    g.requestMtu(512)
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    connectedGatts.remove(address)
                    NativeBridge.onPeerDisconnected(address)
                    try { g.close() } catch (e: Throwable) {}
                }
            } catch (e: Throwable) {
                connectingAddresses.remove(address)
            }
        }

        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            super.onMtuChanged(g, mtu, status)
            // Once MTU is negotiated (whether success or fail), proceed to discover services
            try {
                g.discoverServices()
            } catch (e: Throwable) {}
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            try {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    enableNotifications(g)
                }
            } catch (e: Throwable) {}
        }

        // Called when CCCD descriptor write completes — notifications are now enabled.
        // This is the correct moment to send our presence because:
        //   1. Services are already discovered (onServicesDiscovered ran)
        //   2. The remote peer can receive our notifications (CCCD is set)
        //   3. We can write to characteristics (services are known)
        override fun onDescriptorWrite(
            g: BluetoothGatt,
            descriptor: BluetoothGattDescriptor,
            status: Int
        ) {
            try {
                if (descriptor.uuid == CCCD_UUID && status == BluetoothGatt.GATT_SUCCESS) {
                    // GATT is fully set up now — tell Rust we're connected so it sends presence
                    NativeBridge.onPeerConnected(g.device.address)
                }
            } catch (e: Throwable) {}
        }

        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            try {
                if (characteristic.uuid == MESSAGE_CHAR_UUID) {
                    val bytes = characteristic.value ?: return
                    handleReceivedBytes(g.device.address, bytes)
                }
            } catch (e: Throwable) {}
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

            if (serverDevice == null && clientGatt == null) {
                connectToPeer(ctx, deviceAddress)
                return false
            }

            val handler = Handler(Looper.getMainLooper())
            var delayMs = 0L
            val msgId = (0..255).random().toByte()
            val chunkSize = 16
            val totalChunks = Math.ceil(bytes.size.toDouble() / chunkSize).toInt()

            if (totalChunks <= 1) {
                if (serverDevice != null) {
                    writeToServerDevice(serverDevice, bytes)
                } else if (clientGatt != null) {
                    writeToClientGatt(clientGatt, bytes)
                }
                return true
            }

            for (i in 0 until totalChunks) {
                val start = i * chunkSize
                val end = Math.min(start + chunkSize, bytes.size)
                val payload = bytes.copyOfRange(start, end)
                
                val chunk = ByteArray(payload.size + 4)
                chunk[0] = 0x00
                chunk[1] = msgId
                chunk[2] = totalChunks.toByte()
                chunk[3] = i.toByte()
                System.arraycopy(payload, 0, chunk, 4, payload.size)
                
                handler.postDelayed({
                    if (serverDevice != null) {
                        writeToServerDevice(serverDevice, chunk)
                    } else if (clientGatt != null) {
                        writeToClientGatt(clientGatt, chunk)
                    }
                }, delayMs)
                delayMs += 35L
            }
            true
        } catch (e: Throwable) {
            false
        }
    }

    private fun writeToServerDevice(device: BluetoothDevice, bytes: ByteArray) {
        try {
            val service = gattServer?.getService(SERVICE_UUID)
            val char = service?.getCharacteristic(MESSAGE_CHAR_UUID) ?: return
            if (Build.VERSION.SDK_INT >= 33) {
                gattServer?.notifyCharacteristicChanged(device, char, false, bytes)
            } else {
                @Suppress("DEPRECATION")
                char.value = bytes
                @Suppress("DEPRECATION")
                gattServer?.notifyCharacteristicChanged(device, char, false)
            }
        } catch (e: Throwable) {}
    }

    private fun writeToClientGatt(gatt: BluetoothGatt, bytes: ByteArray) {
        try {
            val service = gatt.getService(SERVICE_UUID) ?: return
            val char = service.getCharacteristic(MESSAGE_CHAR_UUID) ?: return
            if (Build.VERSION.SDK_INT >= 33) {
                gatt.writeCharacteristic(char, bytes, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)
            } else {
                @Suppress("DEPRECATION")
                char.value = bytes
                @Suppress("DEPRECATION")
                gatt.writeCharacteristic(char)
            }
        } catch (e: Throwable) {}
    }

    private fun enableNotifications(gatt: BluetoothGatt) {
        try {
            val service = gatt.getService(SERVICE_UUID) ?: return
            val char = service.getCharacteristic(MESSAGE_CHAR_UUID) ?: return
            gatt.setCharacteristicNotification(char, true)
            val cccd = char.getDescriptor(CCCD_UUID) ?: return
            
            if (Build.VERSION.SDK_INT >= 33) {
                gatt.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            } else {
                @Suppress("DEPRECATION")
                cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                @Suppress("DEPRECATION")
                gatt.writeDescriptor(cccd)
            }
        } catch (e: Throwable) {}
    }
}
