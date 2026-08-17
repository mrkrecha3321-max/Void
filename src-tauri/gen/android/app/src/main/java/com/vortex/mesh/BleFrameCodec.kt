package com.vortex.mesh

/** Pure framing codec shared by Android BLE runtime and JVM unit tests. */
object BleFrameCodec {
    const val CHUNK_SIZE = 16
    const val HEADER_SIZE = 5
    const val MAX_CHUNKS = 255
    const val MAX_MESSAGE_BYTES = CHUNK_SIZE * MAX_CHUNKS
    private const val MARKER: Byte = 0x00

    data class Frame(
        val messageId: Int,
        val totalChunks: Int,
        val chunkIndex: Int,
        val payload: ByteArray
    )

    fun encode(message: ByteArray, messageId: Int): List<ByteArray> {
        if (message.isEmpty() || message.size > MAX_MESSAGE_BYTES || messageId !in 0..0xFFFF) {
            return emptyList()
        }
        val totalChunks = (message.size + CHUNK_SIZE - 1) / CHUNK_SIZE
        return List(totalChunks) { index ->
            val start = index * CHUNK_SIZE
            val end = minOf(start + CHUNK_SIZE, message.size)
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

    fun decode(bytes: ByteArray): Frame? {
        if (bytes.size !in (HEADER_SIZE..(HEADER_SIZE + CHUNK_SIZE)) || bytes[0] != MARKER) {
            return null
        }
        val messageId = ((bytes[1].toInt() and 0xFF) shl 8) or (bytes[2].toInt() and 0xFF)
        val totalChunks = bytes[3].toInt() and 0xFF
        val chunkIndex = bytes[4].toInt() and 0xFF
        if (totalChunks !in 1..MAX_CHUNKS || chunkIndex >= totalChunks) return null
        val payload = bytes.copyOfRange(HEADER_SIZE, bytes.size)
        if (payload.isEmpty()) return null
        return Frame(messageId, totalChunks, chunkIndex, payload)
    }
}
