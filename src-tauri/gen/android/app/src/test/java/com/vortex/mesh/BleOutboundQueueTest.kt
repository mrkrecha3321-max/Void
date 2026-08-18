package com.vortex.mesh

import org.junit.Assert.*
import org.junit.Test

class BleOutboundQueueTest {
    private fun frames(count: Int, prefix: Byte = 1): List<ByteArray> =
        List(count) { index -> byteArrayOf(prefix, index.toByte()) }

    @Test
    fun timeoutRetriesThenFailsSingleFragment() {
        val queue = BleOutboundQueue(maxAttempts = 3)
        assertEquals(EnqueueStatus.QUEUED, queue.enqueue("msg-a", frames(1)))
        assertEquals("msg-a", queue.currentMsgId())

        val first = queue.onTimeout()
        assertEquals(WriteEvent.NEED_WRITE, first.event)
        val second = queue.onTimeout()
        assertEquals(WriteEvent.NEED_WRITE, second.event)
        val failed = queue.onTimeout()
        assertEquals(WriteEvent.MESSAGE_FAILED, failed.event)
        assertEquals("msg-a", failed.meshMsgId)
        assertTrue(queue.isEmpty())
    }

    @Test
    fun middleFragmentFailureAbortsOnlyThatMessage() {
        val queue = BleOutboundQueue(maxAttempts = 2)
        assertEquals(EnqueueStatus.QUEUED, queue.enqueue("msg-1", frames(3, 1)))
        assertEquals(EnqueueStatus.QUEUED, queue.enqueue("msg-2", frames(2, 2)))

        assertEquals(WriteEvent.NEED_WRITE, queue.onWriteSuccess().event)
        val fail = queue.onWriteFailure()
        assertEquals(WriteEvent.NEED_WRITE, fail.event)
        val aborted = queue.onWriteFailure()
        assertEquals(WriteEvent.MESSAGE_FAILED, aborted.event)
        assertEquals("msg-1", aborted.meshMsgId)
        assertEquals("msg-2", queue.currentMsgId())
    }

    @Test
    fun disconnectFailsInFlightAndQueuedMessages() {
        val queue = BleOutboundQueue()
        queue.enqueue("one", frames(2))
        queue.enqueue("two", frames(1))
        val failed = queue.failAll("disconnect mid-message")
        assertEquals(2, failed.size)
        assertEquals(setOf("one", "two"), failed.map { it.meshMsgId }.toSet())
        assertTrue(failed.all { it.event == WriteEvent.MESSAGE_FAILED })
        assertTrue(queue.isEmpty())
    }

    @Test
    fun sameMsgIdIsNotQueuedTwiceWhileInFlight() {
        val queue = BleOutboundQueue()
        assertEquals(EnqueueStatus.QUEUED, queue.enqueue("same", frames(4)))
        assertEquals(EnqueueStatus.ALREADY_QUEUED, queue.enqueue("same", frames(4)))
        assertEquals(1, queue.queuedMessageCount())
        queue.onWriteSuccess()
        assertEquals(EnqueueStatus.ALREADY_QUEUED, queue.enqueue("same", frames(4)))
    }

    @Test
    fun manyMessagesStayOrderedUntilEachLastFragmentSucceeds() {
        val queue = BleOutboundQueue()
        val ids = (1..8).map { "msg-$it" }
        ids.forEach { id -> assertEquals(EnqueueStatus.QUEUED, queue.enqueue(id, frames(3))) }

        val sent = mutableListOf<String>()
        while (!queue.isEmpty()) {
            val result = queue.onWriteSuccess()
            if (result.event == WriteEvent.MESSAGE_SENT) {
                sent += result.meshMsgId!!
            }
        }
        assertEquals(ids, sent)
    }

    @Test
    fun discoveredIsNotOnlineOrReady() {
        assertFalse(BleLinkPolicy.discoveredMeansOnline())
        assertFalse(BleLinkPolicy.connectedMeansTransportReady())
        assertTrue(BleLinkPolicy.canReconnect(0))
        assertFalse(BleLinkPolicy.canReconnect(BleLinkPolicy.MAX_RECONNECT_ATTEMPTS))
        assertFalse(BleLinkPolicy.shouldUseAutoConnect(0))
        assertTrue(BleLinkPolicy.shouldUseAutoConnect(2))
    }
}
