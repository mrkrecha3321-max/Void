package com.vortex.mesh

/**
 * BLE framing.
 *
 * v1 (default outbound marker 0x00): 5-byte header, 8-bit chunk counts, payload <= 16.
 * v2 (marker 0x01): 7-byte header, 16-bit chunk counts, payload sized from MTU.
 *
 * ATT write/notify payload is MTU - 3. A v2 frame never exceeds that.
 */
object BleFrameCodec {
    const val HEADER_SIZE_V1 = BleLinkPolicy.HEADER_V1
    const val HEADER_SIZE_V2 = BleLinkPolicy.HEADER_V2
    const val HEADER_SIZE = HEADER_SIZE_V1
    const val CHUNK_SIZE = 16
    const val MAX_CHUNKS_V1 = 255
    const val MAX_CHUNKS = BleLinkPolicy.MAX_CHUNKS_V2
    const val MAX_MESSAGE_BYTES = BleLinkPolicy.MAX_MESSAGE_BYTES
    const val MAX_FRAME_PAYLOAD = BleLinkPolicy.MAX_FRAME_PAYLOAD
    private const val MARKER_V1: Byte = 0x00
    private const val MARKER_V2: Byte = 0x01

    data class Frame(
        val messageId: Int,
        val totalChunks: Int,
        val chunkIndex: Int,
        val payload: ByteArray,
        val version: Int
    )

    fun payloadCapacityForMtu(mtu: Int): Int = BleLinkPolicy.framePayloadCapacity(mtu)

    fun encode(message: ByteArray, messageId: Int): List<ByteArray> {
        if (message.isEmpty() || message.size > MAX_MESSAGE_BYTES || messageId !in 0..0xFFFF) {
            return emptyList()
        }
        val totalChunks = (message.size + CHUNK_SIZE - 1) / CHUNK_SIZE
        if (totalChunks !in 1..MAX_CHUNKS_V1) return emptyList()
        return List(totalChunks) { index ->
            val start = index * CHUNK_SIZE
            val end = minOf(start + CHUNK_SIZE, message.size)
            val payload = message.copyOfRange(start, end)
            ByteArray(HEADER_SIZE_V1 + payload.size).also { frame ->
                frame[0] = MARKER_V1
                frame[1] = (messageId ushr 8).toByte()
                frame[2] = messageId.toByte()
                frame[3] = totalChunks.toByte()
                frame[4] = index.toByte()
                System.arraycopy(payload, 0, frame, HEADER_SIZE_V1, payload.size)
            }
        }
    }

    // Kept for receiving and compatibility tests with releases 0.2.2-0.2.5.
    fun encode(message: ByteArray, messageId: Int, mtu: Int): List<ByteArray> {
        val chunk = payloadCapacityForMtu(mtu)
        if (message.isEmpty() || message.size > MAX_MESSAGE_BYTES || messageId !in 0..0xFFFF) {
            return emptyList()
        }
        val totalChunks = (message.size + chunk - 1) / chunk
        if (totalChunks !in 1..MAX_CHUNKS) return emptyList()
        return List(totalChunks) { index ->
            val start = index * chunk
            val end = minOf(start + chunk, message.size)
            val payload = message.copyOfRange(start, end)
            val frame = ByteArray(HEADER_SIZE_V2 + payload.size)
            frame[0] = MARKER_V2
            frame[1] = (messageId ushr 8).toByte()
            frame[2] = messageId.toByte()
            frame[3] = (totalChunks ushr 8).toByte()
            frame[4] = totalChunks.toByte()
            frame[5] = (index ushr 8).toByte()
            frame[6] = index.toByte()
            System.arraycopy(payload, 0, frame, HEADER_SIZE_V2, payload.size)
            if (!BleLinkPolicy.frameFitsMtu(frame.size, mtu)) {
                return emptyList()
            }
            frame
        }
    }

    fun decode(bytes: ByteArray): Frame? {
        if (bytes.isEmpty()) return null
        return when (bytes[0]) {
            MARKER_V1 -> decodeV1(bytes)
            MARKER_V2 -> decodeV2(bytes)
            else -> null
        }
    }

    private fun decodeV1(bytes: ByteArray): Frame? {
        if (bytes.size !in (HEADER_SIZE_V1..(HEADER_SIZE_V1 + CHUNK_SIZE))) return null
        val messageId = ((bytes[1].toInt() and 0xFF) shl 8) or (bytes[2].toInt() and 0xFF)
        val totalChunks = bytes[3].toInt() and 0xFF
        val chunkIndex = bytes[4].toInt() and 0xFF
        if (totalChunks !in 1..MAX_CHUNKS_V1 || chunkIndex >= totalChunks) return null
        val payload = bytes.copyOfRange(HEADER_SIZE_V1, bytes.size)
        if (payload.isEmpty()) return null
        return Frame(messageId, totalChunks, chunkIndex, payload, 1)
    }

    private fun decodeV2(bytes: ByteArray): Frame? {
        if (bytes.size < HEADER_SIZE_V2 + 1) return null
        if (bytes.size > HEADER_SIZE_V2 + MAX_FRAME_PAYLOAD) return null
        val messageId = ((bytes[1].toInt() and 0xFF) shl 8) or (bytes[2].toInt() and 0xFF)
        val totalChunks = ((bytes[3].toInt() and 0xFF) shl 8) or (bytes[4].toInt() and 0xFF)
        val chunkIndex = ((bytes[5].toInt() and 0xFF) shl 8) or (bytes[6].toInt() and 0xFF)
        if (totalChunks !in 1..MAX_CHUNKS || chunkIndex >= totalChunks) return null
        val payload = bytes.copyOfRange(HEADER_SIZE_V2, bytes.size)
        if (payload.isEmpty()) return null
        return Frame(messageId, totalChunks, chunkIndex, payload, 2)
    }
}
