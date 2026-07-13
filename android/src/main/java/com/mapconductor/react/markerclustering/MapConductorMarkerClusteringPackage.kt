package com.mapconductor.react.markerclustering

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager
import com.mapconductor.react.extensions.NativeMapExtensionRegistry

@Suppress("DEPRECATION")
class MapConductorMarkerClusteringPackage : ReactPackage {
    init {
        NativeMapExtensionRegistry.register(RENDERER_TYPE) { context, extensionId, eventSink ->
            MarkerClusterGroupRenderer(context, extensionId, eventSink)
        }
    }

    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> = emptyList()

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()

    companion object {
        private const val RENDERER_TYPE = "marker-clustering"
    }
}
