package com.aihangout.companion.diagnostics

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager

/** Real Android framework implementation -- not exercised by JVM unit
 * tests (see DeviceReader's doc); the logic that consumes its output is
 * tested instead, against a fake. */
class AndroidDeviceReader(private val context: Context) : DeviceReader {

    override fun readBatteryStatus(): BatteryStatus {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val percent = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val status = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val chargingStatus = status?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val isCharging = chargingStatus == BatteryManager.BATTERY_STATUS_CHARGING ||
            chargingStatus == BatteryManager.BATTERY_STATUS_FULL
        return BatteryStatus(percent = percent, isCharging = isCharging)
    }

    override fun readNetworkStatus(): NetworkStatus {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = cm.activeNetwork
        val caps = network?.let { cm.getNetworkCapabilities(it) }
        val type = when {
            caps == null -> "none"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
        val metered = cm.isActiveNetworkMetered
        return NetworkStatus(connectionType = type, isMetered = metered)
    }
}
