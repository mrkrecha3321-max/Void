package com.vortex.mesh

/**
 * Pure framing codec shared by the Android BLE runtime and JVM unit tests.
 *
 * Wire format (big-endian):
 *   1B marker (0x00)
 *   2B messageId (16-bit, per-link, wraps safely — reassembly is keyed by
 *      (address, messageId) and expires, so wrap collisions cannot merge two
 *      live transfers)
 *   1B totalChunks
 *   1B chunkIndex
 *   up to `payloadCapacity` bytes of payload
 *
 * The first stable release hard-coded a 16-byte payload even though the link
 * negotiated MTU 512. The payload capacity is now derived from the negotiated
 * MTU: `mtu - 3 (ATT) - HEADER_SIZE`. A receiver accepts any frame whose
 * payload length is between 1 and `maxPayloadForMtu(mtu)` and is a multiple of
 * no particular block size, so mixed 23/185/247/512 links interoperate.
 */
object BleFrameCodec {
    const val HEADER_SIZE = 5
    const val MARKER: Byte = 0x00

    /** Legacy fixed chunk size kept for documentation/interop. */
    const val LEGACY_CHUNK_SIZE = 16

    /** Conservative default MTU; Android always supports at least 23. */
    const val DEFAULT_MTU = 23
    const val MAX_CHUNKS = 255

    /**
     * Maximum supported negotiated MTU. requestMtu(512) is used at connect;
     * values above this are clamped to protect against misbehaving stacks.
     */
    const val MAX_MTU = 517

    /**
     * Maximum payload that fits into a single BLE write/notification for the
     * negotiated MTU. The 3-byte ATT header is mandated by the spec and the
     * 5-byte framing header is ours.
     */
    fun maxPayloadForMtu(mtu: Int): Int {
        val safeMtu = mtu.coerceIn(DEFAULT_MTU, MAX_MTU)
        return (safeMtu - 3 - HEADER_SIZE).coerceAtLeast(1)
    }

    data class Frame(
        val messageId: Int,
        val totalChunks: Int,
        val chunkIndex: Int,
        val payload: ByteArray
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Frame) return false
            return messageId == other.messageId &&
                totalChunks == other.totalChunks &&
                chunkIndex == other.chunkIndex &&
                payload.contentEquals(other.payload)
        }
        override fun hashCode(): Int {
            var result = messageId
            result = 31 * result + totalChunks
            result = 31 * result + chunkIndex
            result = 31 * result + payload.contentHashCode()
            return result
        }
    }

    /**
     * Encode a message using the negotiated MTU. Returns an empty list if the
     * message does not fit within MAX_CHUNKS frames at that MTU.
     */
    fun encode(message: ByteArray, messageId: Int, mtu: Int = DEFAULT_MTU): List<ByteArray> {
        if (message.isEmpty() || messageId !in 0..0xFFFF) return emptyList()
        val chunkSize = maxPayloadForMtu(mtu)
        val maxBytes = chunkSize * MAX_CHUNKS
        if (message.size > maxBytes) return emptyList()
        val totalChunks = (message.size + chunkSize - 1) / chunkSize
        if (totalChunks !in 1..MAX_CHUNKS) return emptyList()
        return List(totalChunks) { index ->
            val start = index * chunkSize
            val end = minOf(start + chunkSize, message.size)
            val payload = message.copyOfRange(start, end)
            ByteArray(HEADER_SIZE + payload.size).also { frame ->
                frame[0] = MARKER
                frame[1] = (messageId ushr 8).toByte()
                frame[2] = messageId.toByte()
                frame[3] = totalChunks.toByte()
                frame[4] = index.toByte()
                System.arraycopy(payload, 0, frame, HEADER_SIZE, payload.size)
            }
        }
    }

    /**
     * Decode a single inbound frame. Accepts any valid frame length from
     * HEADER_SIZE+1 up to the largest possible payload at MAX_MTU, so senders
     * using a higher MTU than us are tolerated per-frame (a too-large single
     * frame is rejected by the GATT layer before reaching here).
     */
    fun decode(bytes: ByteArray): Frame? {
        if (bytes.size < HEADER_SIZE + 1 || bytes[0] != MARKER) return null
        val maxPayload = maxPayloadForMtu(MAX_MTU)
        if (bytes.size > HEADER_SIZE + maxPayload) return null
        val messageId = ((bytes[1].toInt() and 0xFF) shl 8) or (bytes[2].toInt() and 0xFF)
        val totalChunks = bytes[3].toInt() and 0xFF
        val chunkIndex = bytes[4].toInt() and 0xFF
        if (totalChunks !in 1..MAX_CHUNKS || chunkIndex >= totalChunks) return null
        val payload = bytes.copyOfRange(HEADER_SIZE, bytes.size)
        if (payload.isEmpty()) return null
        return Frame(messageId, totalChunks, chunkIndex, payload)
    }

    fun maxMessageBytes(mtu: Int): Int = maxPayloadForMtu(mtu) * MAX_CHUNKS
}
