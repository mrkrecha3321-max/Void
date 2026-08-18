package com.vortex.mesh

/** Pure BLE policy used by the runtime and JVM unit tests. */
object BleLinkPolicy {
    const val ATT_OVERHEAD = 3
    const val HEADER_V1 = 5
    const val HEADER_V2 = 7
    const val DEFAULT_MTU = 23
    const val MAX_FRAME_PAYLOAD = 512
    const val MAX_MESSAGE_BYTES = 4_080
    const val MAX_CHUNKS_V2 = 2_048
    const val MAX_WRITE_ATTEMPTS = 3
    const val MAX_RECONNECT_ATTEMPTS = 8
    const val FRAME_TIMEOUT_MS = 5_000L
    const val MAX_QUEUED_FRAMES = 2_048

    fun attPayloadBytes(mtu: Int): Int =
        (mtu.coerceAtLeast(DEFAULT_MTU) - ATT_OVERHEAD).coerceAtLeast(0)

    fun framePayloadCapacity(mtu: Int): Int =
        (attPayloadBytes(mtu) - HEADER_V2).coerceAtLeast(1).coerceAtMost(MAX_FRAME_PAYLOAD)

    fun frameFitsMtu(frameSize: Int, mtu: Int): Boolean =
        frameSize in 1..attPayloadBytes(mtu)

    fun reconnectDelayMs(attempt: Int): Long {
        val shift = attempt.coerceIn(0, 5)
        return (1_000L shl shift).coerceAtMost(30_000L)
    }

    fun shouldUseAutoConnect(attempt: Int): Boolean = attempt >= 2

    fun canReconnect(attempt: Int): Boolean = attempt in 0 until MAX_RECONNECT_ATTEMPTS

    fun discoveredMeansOnline(): Boolean = false

    fun connectedMeansTransportReady(): Boolean = false

    const val STATUS_DISCOVERED = "discovered"
    const val STATUS_CONNECTING = "connecting"
    const val STATUS_CONNECTED = "connected"
    const val STATUS_READY = "ready"
    const val STATUS_DISCONNECTED = "disconnected"
}
