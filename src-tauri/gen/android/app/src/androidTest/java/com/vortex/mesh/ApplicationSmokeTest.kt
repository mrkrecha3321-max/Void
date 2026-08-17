package com.vortex.mesh

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ApplicationSmokeTest {
    @Test
    fun packageAndApplicationContextAreAvailable() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertEquals("com.vortex.mesh", context.packageName)
        assertNotNull(context.getSystemService(android.content.Context.BLUETOOTH_SERVICE))
    }

    @Test
    fun productionFrameCodecWorksOnAndroidRuntime() {
        val payload = "signed-envelope".toByteArray()
        val frames = BleFrameCodec.encode(payload, 42)
        val decoded = frames.mapNotNull(BleFrameCodec::decode)
        assertEquals(1, decoded.size)
        assertEquals("signed-envelope", decoded.first().payload.toString(Charsets.UTF_8))
    }
}
