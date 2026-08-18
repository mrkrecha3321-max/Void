package com.vortex.mesh

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream

class BleFrameCodecTest {
    @Test
    fun roundTripMultiChunkPayloadAtDefaultMtu() {
        // Default MTU 23 -> payload 15 bytes/frame; 2049 bytes needs many chunks.
        val original = ByteArray(2_049) { index -> (index and 0xFF).toByte() }
        val frames = BleFrameCodec.encode(original, 0xBEEF, BleFrameCodec.DEFAULT_MTU)
        assertTrue(frames.size > 1)

        val decoded = frames.map { frame ->
            BleFrameCodec.decode(frame) ?: throw AssertionError("Generated frame must decode")
        }
        assertTrue(decoded.all { it.messageId == 0xBEEF })
        assertEquals(frames.size, decoded.first().totalChunks)
        assertEquals((0 until frames.size).toList(), decoded.map { it.chunkIndex })

        val output = ByteArrayOutputStream()
        decoded.sortedBy { it.chunkIndex }.forEach { output.write(it.payload) }
        assertArrayEquals(original, output.toByteArray())
    }

    @Test
    fun mtu23MeansLegacyChunkSize() {
        // MTU 23: 23 - 3 (ATT) - 5 (frame header) = 15 bytes payload.
        assertEquals(15, BleFrameCodec.maxPayloadForMtu(23))
        val frames = BleFrameCodec.encode(ByteArray(16), 1, 23)
        assertEquals(2, frames.size)
        assertEquals(15, frames[0].size - BleFrameCodec.HEADER_SIZE)
        assertEquals(1, frames[1].size - BleFrameCodec.HEADER_SIZE)
    }

    @Test
    fun largerMtuUsesFewerChunks() {
        val payload = ByteArray(500) { 0x42 }
        val frames23 = BleFrameCodec.encode(payload, 7, 23)
        val frames185 = BleFrameCodec.encode(payload, 7, 185)
        val frames512 = BleFrameCodec.encode(payload, 7, 512)
        assertTrue(frames185.size < frames23.size)
        assertTrue(frames512.size < frames185.size)
        // MTU 512 -> 504 bytes payload per frame, so 500 bytes fit in one frame.
        assertEquals(1, frames512.size)
    }

    @Test
    fun boundarySizesRoundTripForEveryMtu() {
        for (mtu in listOf(23, 185, 247, 512)) {
            for (size in listOf(1, 15, 16, 17, 185, 244, 500, BleFrameCodec.maxMessageBytes(mtu))) {
                val original = ByteArray(size) { (it % 251).toByte() }
                val frames = BleFrameCodec.encode(original, 7, mtu)
                assertTrue("MTU $mtu size $size must encode", frames.isNotEmpty())
                val restored = ByteArrayOutputStream()
                frames
                    .mapNotNull { BleFrameCodec.decode(it) }
                    .sortedBy { it.chunkIndex }
                    .forEach { restored.write(it.payload) }
                assertArrayEquals("MTU $mtu size $size round trip", original, restored.toByteArray())
            }
        }
    }

    @Test
    fun rejectsMalformedAndOversizedTraffic() {
        assertTrue(BleFrameCodec.encode(byteArrayOf(), 1).isEmpty())
        assertTrue(
            BleFrameCodec.encode(
                ByteArray(BleFrameCodec.maxMessageBytes(BleFrameCodec.MAX_MTU) + 1),
                1,
                BleFrameCodec.MAX_MTU
            ).isEmpty()
        )
        assertNull(BleFrameCodec.decode(byteArrayOf(0, 1, 2, 3)))
        assertNull(BleFrameCodec.decode(byteArrayOf(1, 0, 1, 1, 0, 42)))
        assertNull(BleFrameCodec.decode(byteArrayOf(0, 0, 1, 0, 0, 42)))
        assertNull(BleFrameCodec.decode(byteArrayOf(0, 0, 1, 1, 1, 42)))
        // Frame larger than the maximum negotiated payload must be dropped.
        val tooLong = ByteArray(BleFrameCodec.HEADER_SIZE + BleFrameCodec.maxPayloadForMtu(BleFrameCodec.MAX_MTU) + 1)
        tooLong[0] = 0
        assertNull(BleFrameCodec.decode(tooLong))
    }

    @Test
    fun receiverAcceptsFramesFromHigherMtuSender() {
        // Sender used MTU 512 (504-byte payload); receiver decodes any valid
        // frame up to MAX_MTU-derived capacity, so mixed links interoperate.
        val bigFrame = BleFrameCodec.encode(ByteArray(300) { 0x5A }, 9, 512).single()
        val decoded = BleFrameCodec.decode(bigFrame)
        assertNotNull(decoded)
        assertEquals(300, decoded!!.payload.size)
    }
}
