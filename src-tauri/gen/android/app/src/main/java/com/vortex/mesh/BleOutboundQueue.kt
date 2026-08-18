package com.vortex.mesh

import java.util.ArrayDeque

enum class EnqueueStatus { QUEUED, ALREADY_QUEUED, REJECTED }

enum class WriteEvent { NEED_WRITE, MESSAGE_SENT, MESSAGE_FAILED, IDLE }

data class WriteResult(
    val event: WriteEvent,
    val meshMsgId: String? = null,
    val reason: String? = null,
    val frame: ByteArray? = null
)

/**
 * Per-link message queue. Fragments of one mesh msgId are sent strictly in
 * order; the next frame is only exposed after the previous write completes.
 */
class BleOutboundQueue(
    private val maxAttempts: Int = BleLinkPolicy.MAX_WRITE_ATTEMPTS,
    private val maxQueuedFrames: Int = BleLinkPolicy.MAX_QUEUED_FRAMES
) {
    private data class OutboundFrame(val bytes: ByteArray, var attempts: Int = 0)
    private data class OutboundMessage(
        val meshMsgId: String,
        val frames: ArrayDeque<OutboundFrame>
    )

    private val messages = ArrayDeque<OutboundMessage>()
    private val knownIds = LinkedHashSet<String>()

    @Synchronized
    fun contains(msgId: String): Boolean = knownIds.contains(msgId)

    @Synchronized
    fun isEmpty(): Boolean = messages.isEmpty()

    @Synchronized
    fun queuedMessageCount(): Int = messages.size

    @Synchronized
    fun currentMsgId(): String? = messages.peekFirst()?.meshMsgId

    @Synchronized
    fun currentFrame(): ByteArray? = messages.peekFirst()?.frames?.peekFirst()?.bytes

    @Synchronized
    fun enqueue(msgId: String, frames: List<ByteArray>): EnqueueStatus {
        if (msgId.isBlank() || frames.isEmpty() || frames.any { it.isEmpty() }) {
            return EnqueueStatus.REJECTED
        }
        if (knownIds.contains(msgId)) return EnqueueStatus.ALREADY_QUEUED
        val total = messages.sumOf { it.frames.size } + frames.size
        if (total > maxQueuedFrames) return EnqueueStatus.REJECTED
        val queue = ArrayDeque<OutboundFrame>(frames.size)
        frames.forEach { queue.addLast(OutboundFrame(it)) }
        messages.addLast(OutboundMessage(msgId, queue))
        knownIds.add(msgId)
        return EnqueueStatus.QUEUED
    }

    @Synchronized
    fun onWriteSuccess(): WriteResult {
        val message = messages.peekFirst() ?: return WriteResult(WriteEvent.IDLE)
        if (message.frames.isEmpty()) return failCurrent("empty frames")
        message.frames.removeFirst()
        if (message.frames.isEmpty()) {
            messages.removeFirst()
            knownIds.remove(message.meshMsgId)
            return WriteResult(WriteEvent.MESSAGE_SENT, message.meshMsgId)
        }
        return WriteResult(
            WriteEvent.NEED_WRITE,
            message.meshMsgId,
            frame = message.frames.peekFirst()?.bytes
        )
    }

    @Synchronized
    fun onWriteFailure(): WriteResult {
        val message = messages.peekFirst() ?: return WriteResult(WriteEvent.IDLE)
        val frame = message.frames.peekFirst() ?: return failCurrent("empty frames")
        frame.attempts += 1
        if (frame.attempts >= maxAttempts) {
            return failCurrent("frame failed after $maxAttempts attempts")
        }
        return WriteResult(WriteEvent.NEED_WRITE, message.meshMsgId, frame = frame.bytes)
    }

    @Synchronized
    fun onTimeout(): WriteResult = onWriteFailure()

    @Synchronized
    fun failCurrent(reason: String): WriteResult {
        val message = messages.peekFirst() ?: return WriteResult(WriteEvent.IDLE)
        messages.removeFirst()
        knownIds.remove(message.meshMsgId)
        return WriteResult(WriteEvent.MESSAGE_FAILED, message.meshMsgId, reason)
    }

    @Synchronized
    fun failAll(reason: String): List<WriteResult> {
        val results = messages.map { WriteResult(WriteEvent.MESSAGE_FAILED, it.meshMsgId, reason) }
        messages.clear()
        knownIds.clear()
        return results
    }
}
