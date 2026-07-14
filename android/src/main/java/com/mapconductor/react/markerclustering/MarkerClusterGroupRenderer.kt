package com.mapconductor.react.markerclustering

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.BitmapDrawable
import android.util.LruCache
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableMap
import com.mapconductor.compose.MapViewScope
import com.mapconductor.core.marker.ColorDefaultIcon
import com.mapconductor.core.marker.ImageIcon
import com.mapconductor.core.marker.MarkerIconInterface
import com.mapconductor.core.marker.MarkerState
import com.mapconductor.marker.clustering.MarkerClusterGroup
import com.mapconductor.marker.clustering.MarkerClusterGroupState
import com.mapconductor.marker.clustering.MarkerClusterStrategy
import com.mapconductor.react.extensions.NativeMapExtensionEventSink
import com.mapconductor.react.extensions.NativeMapExtensionRenderer
import com.mapconductor.react.marker.decodeNativeImageBitmap
import com.mapconductor.react.marker.decodeNativeMarkerBatch
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.Executors

class MarkerClusterGroupRenderer(
    private val context: Context,
    private val extensionId: String,
    private val eventSink: NativeMapExtensionEventSink,
) : NativeMapExtensionRenderer {
    private val ingestDispatcher: CoroutineDispatcher =
        Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "MarkerClusterIngest-$extensionId").apply { isDaemon = true }
        }.asCoroutineDispatcher()
    private val scope = CoroutineScope(ingestDispatcher)
    private var updateJob: Job? = null
    private var markers by mutableStateOf<List<MarkerState>>(emptyList())
    private var options = ClusterOptions.Default
    private val state = options.toState(context, ::emitClusterClick)

    override fun update(payload: ReadableMap?) {
        val nextOptions = ClusterOptions.fromReadableMap(payload?.map("options"), context)
        if (nextOptions != options) {
            val previousOptions = options
            options = nextOptions
            updateState(previousOptions, nextOptions)
        }

        val markerPayload = payload?.map("markers")
        val previous = markers.associateBy { it.id }
        updateJob?.cancel()
        updateJob =
            scope.launch {
                val decoded =
                    decodeNativeMarkerBatch(markerPayload, context, previous) { eventName, marker ->
                        eventSink.emit(
                            extensionId,
                            eventName,
                            Arguments.createMap().apply {
                                putString("markerId", marker.id)
                                putDouble("latitude", marker.position.latitude)
                                putDouble("longitude", marker.position.longitude)
                            },
                        )
                    }
                withContext(Dispatchers.Main) {
                    markers = decoded
                }
            }
    }

    @Composable
    override fun MapViewScope.Render() {
        MarkerClusterGroup(
            state = state,
            markers = markers,
            trackMarkerUpdates = false,
        )
    }

    override fun dispose() {
        updateJob?.cancel()
        scope.cancel()
        (ingestDispatcher as? java.io.Closeable)?.close()
    }

    private fun emitClusterClick(
        count: Int,
        markerIds: List<String>,
    ) {
        eventSink.emit(
            extensionId,
            "clusterClick",
            Arguments.createMap().apply {
                putInt("count", count)
                putArray("markerIds", Arguments.fromList(markerIds))
            },
        )
    }

    private fun updateState(
        previous: ClusterOptions,
        next: ClusterOptions,
    ) {
        if (previous.clusterRadiusPx != next.clusterRadiusPx) {
            state.clusterRadiusPx = next.clusterRadiusPx
        }
        if (previous.minClusterSize != next.minClusterSize) {
            state.minClusterSize = next.minClusterSize
        }
        if (previous.expandMargin != next.expandMargin) {
            state.expandMargin = next.expandMargin
        }
        if (
            previous.clusterIcon != next.clusterIcon ||
            previous.nativeClusterIcon != next.nativeClusterIcon
        ) {
            state.clusterIconProvider = { count ->
                next.nativeClusterIcon?.toIcon(context, count)
                    ?: next.clusterIcon?.toIcon(count)
                    ?: MarkerClusterStrategy.DEFAULT_ICON_PROVIDER(count)
            }
        }
        if (previous.onClusterClickEnabled != next.onClusterClickEnabled) {
            state.onClusterClick =
                if (next.onClusterClickEnabled) {
                    { cluster -> emitClusterClick(cluster.count, cluster.markerIds) }
                } else {
                    null
                }
        }
        if (previous.enableZoomAnimation != next.enableZoomAnimation) {
            state.enableZoomAnimation = next.enableZoomAnimation
        }
        if (previous.enablePanAnimation != next.enablePanAnimation) {
            state.enablePanAnimation = next.enablePanAnimation
        }
        if (previous.zoomAnimationDurationMillis != next.zoomAnimationDurationMillis) {
            state.zoomAnimationDurationMillis = next.zoomAnimationDurationMillis
        }
        if (previous.debugHullPolygons != next.debugHullPolygons) {
            setDebugHullPolygons(next.debugHullPolygons)
        }
        if (previous.cameraIdleDebounceMillis != next.cameraIdleDebounceMillis) {
            state.cameraIdleDebounceMillis = next.cameraIdleDebounceMillis
        }
        if (previous.tileSize != next.tileSize) {
            state.tileSize = next.tileSize
        }
    }

    private fun setDebugHullPolygons(enabled: Boolean) {
        state.debugHullPolygons = enabled
    }
}

private data class ClusterOptions(
    val clusterRadiusPx: Double,
    val minClusterSize: Int,
    val expandMargin: Double,
    val clusterIcon: ClusterIconOptions?,
    val nativeClusterIcon: NativeClusterIconOptions?,
    val onClusterClickEnabled: Boolean,
    val enableZoomAnimation: Boolean,
    val enablePanAnimation: Boolean,
    val zoomAnimationDurationMillis: Long,
    val debugHullPolygons: Boolean,
    val cameraIdleDebounceMillis: Long,
    val tileSize: Double,
) {
    fun toState(
        context: Context,
        onClusterClick: (Int, List<String>) -> Unit,
    ): MarkerClusterGroupState =
        MarkerClusterGroupState(
            clusterRadiusPx = clusterRadiusPx,
            minClusterSize = minClusterSize,
            expandMargin = expandMargin,
            clusterIconProvider = { count ->
                nativeClusterIcon?.toIcon(context, count)
                    ?: clusterIcon?.toIcon(count)
                    ?: MarkerClusterStrategy.DEFAULT_ICON_PROVIDER(count)
            },
            onClusterClick =
                if (onClusterClickEnabled) {
                    { cluster -> onClusterClick(cluster.count, cluster.markerIds) }
                } else {
                    null
                },
            enableZoomAnimation = enableZoomAnimation,
            enablePanAnimation = enablePanAnimation,
            zoomAnimationDurationMillis = zoomAnimationDurationMillis,
            debugHullPolygons = debugHullPolygons,
            cameraIdleDebounceMillis = cameraIdleDebounceMillis,
            tileSize = tileSize,
        )

    companion object {
        val Default =
            ClusterOptions(
                clusterRadiusPx = MarkerClusterStrategy.DEFAULT_CLUSTER_RADIUS_PX,
                minClusterSize = MarkerClusterStrategy.DEFAULT_MIN_CLUSTER_SIZE,
                expandMargin = MarkerClusterStrategy.DEFAULT_EXPAND_MARGIN,
                clusterIcon = null,
                nativeClusterIcon = null,
                onClusterClickEnabled = false,
                enableZoomAnimation = false,
                enablePanAnimation = false,
                zoomAnimationDurationMillis = MarkerClusterStrategy.DEFAULT_ZOOM_ANIMATION_DURATION_MILLIS,
                debugHullPolygons = false,
                cameraIdleDebounceMillis = MarkerClusterStrategy.DEFAULT_CAMERA_DEBOUNCE_MILLIS,
                tileSize = MarkerClusterStrategy.DEFAULT_TILE_SIZE,
            )

        fun fromReadableMap(
            map: ReadableMap?,
            context: Context,
        ): ClusterOptions =
            ClusterOptions(
                clusterRadiusPx = map?.number("clusterRadiusPx") ?: Default.clusterRadiusPx,
                minClusterSize = map?.number("minClusterSize")?.toInt() ?: Default.minClusterSize,
                expandMargin = map?.number("expandMargin") ?: Default.expandMargin,
                clusterIcon = ClusterIconOptions.fromReadableMap(map?.map("clusterIcon")),
                nativeClusterIcon = NativeClusterIconOptions.fromReadableMap(map?.map("clusterIconProvider"), context),
                onClusterClickEnabled = map?.boolean("onClusterClickEnabled") ?: false,
                enableZoomAnimation = map?.boolean("enableZoomAnimation") ?: false,
                enablePanAnimation = map?.boolean("enablePanAnimation") ?: false,
                zoomAnimationDurationMillis =
                    map?.number("zoomAnimationDurationMs")?.toLong() ?: Default.zoomAnimationDurationMillis,
                debugHullPolygons = map?.boolean("debugHullPolygons") ?: false,
                cameraIdleDebounceMillis =
                    map?.number("cameraIdleDebounceMs")?.toLong() ?: Default.cameraIdleDebounceMillis,
                tileSize = map?.number("tileSize") ?: Default.tileSize,
            )
    }
}

private data class NativeClusterIconOptions(
    val background: Bitmap,
    val iconSize: Float,
    val scale: Float,
    val anchor: Offset,
    val infoAnchor: Offset,
    val debug: Boolean,
) {
    private val iconCache = LruCache<String, MarkerIconInterface>(128)

    @Synchronized
    fun toIcon(
        context: Context,
        count: Int,
    ): MarkerIconInterface {
        val label = clusterCountLabel(count)
        iconCache.get(label)?.let { return it }

        val icon =
            ImageIcon(
                image = BitmapDrawable(context.resources, drawClusterIcon(background, label)),
                iconSize = iconSize.dp,
                scale = scale,
                anchor = anchor,
                infoAnchor = infoAnchor,
                debug = debug,
            )
        iconCache.put(label, icon)
        return icon
    }

    companion object {
        fun fromReadableMap(
            map: ReadableMap?,
            context: Context,
        ): NativeClusterIconOptions? {
            if (map == null) return null
            val type = map.string("type")
            if (type != "image" && type != "imageDefault") return null
            val uri = map.string("uri") ?: return null
            val background = decodeNativeImageBitmap(uri, context) ?: return null
            return NativeClusterIconOptions(
                background = background,
                iconSize = (map.number("iconSize") ?: 48.0).toFloat(),
                scale = (map.number("scale") ?: 1.0).toFloat(),
                anchor = map.offset("anchor", Offset(0.5f, 0.5f)),
                infoAnchor = map.offset("infoAnchor", Offset(0.5f, 0.5f)),
                debug = map.boolean("debug") ?: false,
            )
        }
    }
}

private fun clusterCountLabel(count: Int): String =
    when {
        count > 1_000 -> "1k+"
        count > 200 -> "200+"
        count > 100 -> "100+"
        else -> count.toString()
    }

private fun drawClusterIcon(
    background: Bitmap,
    label: String,
): Bitmap {
    val bitmap = background.copy(Bitmap.Config.ARGB_8888, true)
    val canvas = Canvas(bitmap)
    val bubbleCenterY = (background.height * 0.22f).toInt()
    val fontSize = (background.height * 0.35f).toInt().toFloat()
    val textPaint =
        Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = android.graphics.Color.WHITE
            textSize = fontSize
            textAlign = Paint.Align.CENTER
            isSubpixelText = true
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
        }
    val fontMetrics = textPaint.fontMetrics
    val baseline = bubbleCenterY - (fontMetrics.ascent + fontMetrics.descent) / 2f
    canvas.drawText(label, background.width / 2f, baseline, textPaint)
    return bitmap
}

private data class ClusterIconOptions(
    val fillColor: Color,
    val strokeColor: Color,
    val strokeWidth: Float,
    val scale: Float,
    val labelTextColor: Color?,
    val labelTextSize: Float,
    val labelStrokeColor: Color,
    val iconSize: Float,
    val debug: Boolean,
) {
    fun toIcon(count: Int): MarkerIconInterface =
        ColorDefaultIcon(
            fillColor = fillColor,
            strokeColor = strokeColor,
            strokeWidth = strokeWidth.dp,
            scale = scale,
            label = count.toString(),
            labelTextColor = labelTextColor,
            labelTextSize = labelTextSize.sp,
            labelStrokeColor = labelStrokeColor,
            infoAnchor = Offset(0.5f, 0f),
            iconSize = iconSize.dp,
            debug = debug,
        )

    companion object {
        fun fromReadableMap(map: ReadableMap?): ClusterIconOptions? {
            if (map == null) return null
            return ClusterIconOptions(
                fillColor = parseColor(map.string("fillColor"), Color.Red),
                strokeColor = parseColor(map.string("strokeColor"), Color.White),
                strokeWidth = (map.number("strokeWidth") ?: 1.0).toFloat(),
                scale = (map.number("scale") ?: 1.0).toFloat(),
                labelTextColor =
                    if (map.hasKey("labelTextColor") && map.isNull("labelTextColor")) null else
                        parseColor(map.string("labelTextColor"), Color.Black),
                labelTextSize = (map.number("labelTextSize") ?: 18.0).toFloat(),
                labelStrokeColor = parseColor(map.string("labelStrokeColor"), Color.White),
                iconSize = (map.number("iconSize") ?: 48.0).toFloat(),
                debug = map.boolean("debug") ?: false,
            )
        }
    }
}

private fun ReadableMap.string(key: String): String? =
    if (hasKey(key) && !isNull(key)) getString(key) else null

private fun ReadableMap.map(key: String): ReadableMap? =
    if (hasKey(key) && !isNull(key)) getMap(key) else null

private fun ReadableMap.boolean(key: String): Boolean? =
    if (hasKey(key) && !isNull(key)) getBoolean(key) else null

private fun ReadableMap.number(key: String): Double? =
    if (hasKey(key) && !isNull(key)) getDouble(key) else null

private fun ReadableMap.offset(
    key: String,
    fallback: Offset,
): Offset {
    val value = map(key) ?: return fallback
    return Offset(
        x = (value.number("x") ?: fallback.x.toDouble()).toFloat(),
        y = (value.number("y") ?: fallback.y.toDouble()).toFloat(),
    )
}

private fun parseColor(
    value: String?,
    fallback: Color,
): Color = value?.let { runCatching { Color(android.graphics.Color.parseColor(it)) }.getOrNull() } ?: fallback
