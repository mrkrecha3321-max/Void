package com.vortex.mesh

import android.app.PendingIntent
import android.content.Intent
import android.content.IntentFilter
import android.nfc.NdefMessage
import android.nfc.NdefRecord
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.Ndef
import android.nfc.tech.NdefFormatable
import android.os.Build

object NfcManager {
    private var nfcAdapter: NfcAdapter? = null

    @JvmStatic
    fun init(activity: MainActivity) {
        try {
            nfcAdapter = NfcAdapter.getDefaultAdapter(activity)
        } catch (e: Throwable) {
            nfcAdapter = null
        }
    }

    @JvmStatic
    fun isAvailable(): Boolean = nfcAdapter != null

    @JvmStatic
    fun enableForegroundDispatch(activity: MainActivity) {
        val adapter = nfcAdapter ?: return

        val intent = Intent(activity, activity.javaClass).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val flags = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
        val pendingIntent = PendingIntent.getActivity(activity, 0, intent, flags)

        // Keep all three filters because Samsung devices may report TAG_DISCOVERED.
        val filters = arrayOf(
            IntentFilter(NfcAdapter.ACTION_NDEF_DISCOVERED),
            IntentFilter(NfcAdapter.ACTION_TAG_DISCOVERED),
            IntentFilter(NfcAdapter.ACTION_TECH_DISCOVERED)
        )

        try {
            adapter.enableForegroundDispatch(activity, pendingIntent, filters, null)
        } catch (error: Exception) {
            try { NativeBridge.onNfcError("NFC dispatch failed: ${error.message}") } catch (_: Throwable) {}
        }
    }

    @JvmStatic
    fun disableForegroundDispatch(activity: MainActivity) {
        try { nfcAdapter?.disableForegroundDispatch(activity) } catch (e: Exception) {}
    }

    @JvmStatic
    fun handleIntent(intent: Intent) {
        val action = intent.action ?: return

        when (action) {
            NfcAdapter.ACTION_NDEF_DISCOVERED -> {
                @Suppress("DEPRECATION")
                val rawMsgs = intent.getParcelableArrayExtra(NfcAdapter.EXTRA_NDEF_MESSAGES)
                if (rawMsgs != null && rawMsgs.isNotEmpty()) {
                    val msg = rawMsgs[0] as NdefMessage
                    for (record in msg.records) {
                        val text = parseNdefRecord(record) ?: continue
                        if (text.startsWith("VOID2:")) {
                            NativeBridge.onNfcTagRead(text)
                            return
                        }
                    }
                }
                readTagFromIntent(intent)
            }

            NfcAdapter.ACTION_TAG_DISCOVERED,
            NfcAdapter.ACTION_TECH_DISCOVERED -> {
                readTagFromIntent(intent)
            }
        }
    }

    private fun readTagFromIntent(intent: Intent) {
        try {
            @Suppress("DEPRECATION")
            val tag = intent.getParcelableExtra<Tag>(NfcAdapter.EXTRA_TAG) ?: return
            val ndef = Ndef.get(tag) ?: return
            ndef.connect()
            val message = ndef.ndefMessage
            ndef.close()
            message ?: return
            for (record in message.records) {
                val text = parseNdefRecord(record) ?: continue
                if (text.startsWith("VOID2:")) {
                    NativeBridge.onNfcTagRead(text)
                    return
                }
            }
        } catch (error: Throwable) {
            try { NativeBridge.onNfcError("NFC read failed: ${error.message}") } catch (_: Throwable) {}
        }
    }

    /**
     * Parse an NDEF record. For Well-Known Text records the payload is:
     *   [status_byte (1)] [language_code (N bytes)] [text bytes]
     * where N = status_byte & 0x3F.
     * We must strip these prefix bytes to get the actual text.
     */
    private fun parseNdefRecord(record: NdefRecord): String? {
        return try {
            val payload = record.payload ?: return null
            if (payload.isEmpty()) return null

            if (record.tnf == NdefRecord.TNF_WELL_KNOWN &&
                record.type.contentEquals(NdefRecord.RTD_TEXT)) {
                val langLen = (payload[0].toInt() and 0x3F)
                val start   = 1 + langLen
                if (start >= payload.size) return null
                String(payload, start, payload.size - start, Charsets.UTF_8)
            } else {
                String(payload, Charsets.UTF_8)
            }
        } catch (e: Throwable) {
            null
        }
    }

    @JvmStatic
    fun writeProfileTag(tag: Tag, payload: String): Boolean {
        return try {
            val record  = NdefRecord.createTextRecord("en", payload)
            val message = NdefMessage(arrayOf(record))

            val ndef = Ndef.get(tag)
            if (ndef != null) {
                ndef.connect()
                ndef.writeNdefMessage(message)
                ndef.close()
                return true
            }

            val formatable = NdefFormatable.get(tag)
            if (formatable != null) {
                formatable.connect()
                formatable.format(message)
                formatable.close()
                return true
            }
            false
        } catch (e: Exception) {
            false
        }
    }
}
