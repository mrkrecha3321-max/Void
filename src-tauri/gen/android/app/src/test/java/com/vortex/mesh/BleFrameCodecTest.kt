package com.vortex.mesh

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream

class BleFrameCodecTest {
    @Test
    fun roundTripMultiChunkPayload() {
        val original = ByteArray(2_049) { index -> (index and 0xFF).toByte() }
        val frames = BleFrameCodec.encode(original, 0xBEEF)
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
    fun boundarySizesRoundTrip() {
        for (size in listOf(1, 16, 17, BleFrameCodec.MAX_MESSAGE_BYTES)) {
            val original = ByteArray(size) { 0x5A }
            val frames = BleFrameCodec.encode(original, 7)
            assertTrue(frames.isNotEmpty())
            val restored = frames
                .mapNotNull(BleFrameCodec::decode)
                .sortedBy { it.chunkIndex }
                .flatMap { it.payload.asIterable() }
                .toByteArray()
            assertArrayEquals(original, restored)
        }
    }

    @Test
    fun rejectsMalformedAndOversizedTraffic() {
        assertTrue(BleFrameCodec.encode(byteArrayOf(), 1).isEmpty())
        assertTrue(BleFrameCodec.encode(ByteArray(BleFrameCodec.MAX_MESSAGE_BYTES + 1), 1).isEmpty())
        assertNull(BleFrameCodec.decode(byteArrayOf(0, 1, 2, 3)))
        assertNull(BleFrameCodec.decode(byteArrayOf(1, 0, 1, 1, 0, 42)))
        assertNull(BleFrameCodec.decode(byteArrayOf(0, 0, 1, 0, 0, 42)))
        assertNull(BleFrameCodec.decode(byteArrayOf(0, 0, 1, 1, 1, 42)))
    }

    @Test
    fun framesNeverExceedAttPayloadForKnownMtu() {
        val payload = ByteArray(800) { 0x11 }
        for (mtu in listOf(23, 185, 247, 512)) {
            val frames = BleFrameCodec.encode(payload, 9, mtu)
            assertTrue("mtu=$mtu should produce frames", frames.isNotEmpty())
            val attLimit = BleLinkPolicy.attPayloadBytes(mtu)
            frames.forEach { frame ->
                assertTrue("mtu=$mtu frame=${frame.size} att=$attLimit", frame.size <= attLimit)
                val decoded = BleFrameCodec.decode(frame)
                assertNotNull(decoded)
                assertEquals(2, decoded!!.version)
            }
            val restored = frames.mapNotNull(BleFrameCodec::decode)
                .sortedBy { it.chunkIndex }
                .flatMap { it.payload.asIterable() }
                .toByteArray()
            assertArrayEquals(payload, restored)
        }
    }

    @Test
    fun receiverAcceptsLegacyV1AndVariableV2() {
        val legacy = byteArrayOf(0, 0, 7, 1, 0, 65, 66)
        val decodedLegacy = BleFrameCodec.decode(legacy)
        assertNotNull(decodedLegacy)
        assertEquals(1, decodedLegacy!!.version)
        assertEquals("AB", decodedLegacy.payload.toString(Charsets.US_ASCII))

        val v2 = BleFrameCodec.encode("hello-world".toByteArray(), 3, 185)
        assertEquals(1, v2.size)
        val decoded = BleFrameCodec.decode(v2.first())
        assertEquals(2, decoded!!.version)
        assertEquals("hello-world", decoded.payload.toString(Charsets.UTF_8))
    }
}
