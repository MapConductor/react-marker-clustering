import Foundation
import MapConductorCore
import MapConductorMarkerCluster
import MapConductorReactNativeCore
import UIKit

/// iOS counterpart of Android's `MarkerClusterGroupRenderer.kt`.
///
/// `MarkerClusterGroupState` itself isn't generic (see its doc comment), so all option/marker
/// decoding here is fully shared between providers; only the final `MarkerClusterGroup<ActualMarker>`
/// construction in `makeContent()` needs the concrete native marker type, which is why this class
/// is generic and each provider package instantiates its own specialization (`GoogleMapActualMarker`,
/// `MapLibreActualMarker`) via `NativeMapExtensionHost`'s `localFactory` hook instead of the shared
/// global `NativeMapExtensionRegistry`.
public final class MarkerClusterExtensionRenderer<ActualMarker>: NativeMapExtensionRenderer {
    private let extensionId: String
    private let eventSink: NativeMapExtensionEventSink
    private let state = MarkerClusterGroupState()
    private var markersById: [String: MarkerState] = [:]
    private var markers: [MarkerState] = []

    public init(extensionId: String, eventSink: @escaping NativeMapExtensionEventSink) {
        self.extensionId = extensionId
        self.eventSink = eventSink
    }

    public func update(payload: [String: Any]) {
        let options = MarkerClusterOptions.decode(mcMap(payload["options"]))
        state.clusterRadiusPx = options.clusterRadiusPx
        state.minClusterSize = options.minClusterSize
        state.expandMargin = options.expandMargin
        state.enableZoomAnimation = options.enableZoomAnimation
        state.enablePanAnimation = options.enablePanAnimation
        state.zoomAnimationDurationMillis = options.zoomAnimationDurationMillis
        state.cameraIdleDebounceMillis = options.cameraIdleDebounceMillis
        state.tileSize = options.tileSize
        state.debugHullPolygons = options.debugHullPolygons
        state.clusterIconProvider = options.iconProvider
        state.onClusterClick = options.onClusterClickEnabled
            ? { [weak self] cluster in
                guard let self else { return }
                self.eventSink(self.extensionId, "clusterClick", [
                    "count": cluster.count,
                    "markerIds": cluster.markerIds
                ])
            }
            : nil

        let markerPayload = mcMap(payload["markers"])
        markers = mcMarkerStatesFromBatch(
            markerPayload ?? [:],
            previousStates: markersById,
            onEvent: { [weak self] name, marker in self?.emitMarkerEvent(name, marker) }
        )
        markersById = Dictionary(uniqueKeysWithValues: markers.map { ($0.id, $0) })
    }

    public func dispose() {}

    public func makeContent() -> MapViewContent {
        MapViewContentBuilder.buildExpression(MarkerClusterGroup<ActualMarker>(state: state, markers: markers))
    }

    private func emitMarkerEvent(_ name: String, _ marker: MarkerState) {
        eventSink(extensionId, name, [
            "markerId": marker.id,
            "latitude": marker.position.latitude,
            "longitude": marker.position.longitude
        ])
    }
}

// `MarkerClusterExtensionRenderer` is generic, and Swift doesn't support static stored
// properties on generic types (or types nested inside them) — these helpers don't reference
// `ActualMarker` at all, so they're declared at file scope instead of nested in the class.

private struct MarkerClusterOptions {
    let clusterRadiusPx: Double
    let minClusterSize: Int
    let expandMargin: Double
    let onClusterClickEnabled: Bool
    let enableZoomAnimation: Bool
    let enablePanAnimation: Bool
    let zoomAnimationDurationMillis: Int
    let cameraIdleDebounceMillis: Int
    let tileSize: Double
    let debugHullPolygons: Bool
    let iconProvider: MarkerClusterGroupState.ClusterIconProvider

    static let Default = MarkerClusterOptions(
        clusterRadiusPx: MarkerClusterDefaults.clusterRadiusPx,
        minClusterSize: MarkerClusterDefaults.minClusterSize,
        expandMargin: MarkerClusterDefaults.expandMargin,
        onClusterClickEnabled: false,
        enableZoomAnimation: false,
        enablePanAnimation: false,
        zoomAnimationDurationMillis: MarkerClusterDefaults.zoomAnimationDurationMillis,
        cameraIdleDebounceMillis: MarkerClusterDefaults.cameraIdleDebounceMillis,
        tileSize: MarkerClusterDefaults.tileSize,
        debugHullPolygons: false,
        iconProvider: MarkerClusterDefaults.iconProvider
    )

    static func decode(_ map: [String: Any]?) -> MarkerClusterOptions {
        guard let map else { return .Default }
        let iconProvider = ClusterIconOptions.decode(mcMap(map["clusterIconProvider"]))?.iconProvider
            ?? ColorClusterIconOptions.decode(mcMap(map["clusterIcon"]))?.iconProvider
            ?? Default.iconProvider
        return MarkerClusterOptions(
            clusterRadiusPx: mcDouble(map["clusterRadiusPx"], default: Default.clusterRadiusPx),
            minClusterSize: mcInt(map["minClusterSize"], default: Default.minClusterSize),
            expandMargin: mcDouble(map["expandMargin"], default: Default.expandMargin),
            onClusterClickEnabled: mcBool(map["onClusterClickEnabled"], default: false),
            enableZoomAnimation: mcBool(map["enableZoomAnimation"], default: false),
            enablePanAnimation: mcBool(map["enablePanAnimation"], default: false),
            zoomAnimationDurationMillis: mcInt(map["zoomAnimationDurationMs"], default: Default.zoomAnimationDurationMillis),
            cameraIdleDebounceMillis: mcInt(map["cameraIdleDebounceMs"], default: Default.cameraIdleDebounceMillis),
            tileSize: mcDouble(map["tileSize"], default: Default.tileSize),
            debugHullPolygons: mcBool(map["debugHullPolygons"], default: false),
            iconProvider: iconProvider
        )
    }
}

/// A caller-provided image (e.g. `imageDefault`) with the cluster count drawn on top,
/// mirroring Android's `NativeClusterIconOptions`/`drawClusterIcon`.
private struct ClusterIconOptions {
    let background: UIImage
    let iconSize: CGFloat
    let scale: CGFloat
    let anchor: CGPoint
    let infoAnchor: CGPoint
    let debug: Bool

    static func decode(_ map: [String: Any]?) -> ClusterIconOptions? {
        guard let map, let type = mcString(map["type"]), type == "image" || type == "imageDefault",
              let uri = mcString(map["uri"]), let background = mcLoadImage(uri: uri) else { return nil }
        return ClusterIconOptions(
            background: background,
            iconSize: CGFloat(mcDouble(map["iconSize"], default: 48.0)),
            scale: CGFloat(mcDouble(map["scale"], default: 1.0)),
            anchor: mcOffset(map["anchor"], default: CGPoint(x: 0.5, y: 0.5)),
            infoAnchor: mcOffset(map["infoAnchor"], default: CGPoint(x: 0.5, y: 0.5)),
            debug: mcBool(map["debug"], default: false)
        )
    }

    var iconProvider: MarkerClusterGroupState.ClusterIconProvider {
        { count in
            ImageIcon(
                image: Self.drawClusterIcon(background: self.background, label: Self.label(for: count)),
                iconSize: self.iconSize,
                scale: self.scale,
                anchor: self.anchor,
                infoAnchor: self.infoAnchor,
                debug: self.debug
            )
        }
    }

    private static func label(for count: Int) -> String {
        switch count {
        case ...100: return "\(count)"
        case ...200: return "100+"
        case ...1000: return "200+"
        default: return "1k+"
        }
    }

    private static func drawClusterIcon(background: UIImage, label: String) -> UIImage {
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = background.scale
        let renderer = UIGraphicsImageRenderer(size: background.size, format: format)
        return renderer.image { _ in
            background.draw(at: .zero)
            let fontSize = background.size.height * 0.35
            let paragraph = NSMutableParagraphStyle()
            paragraph.alignment = .center
            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.boldSystemFont(ofSize: fontSize),
                .foregroundColor: UIColor.white,
                .paragraphStyle: paragraph
            ]
            let textHeight = label.size(withAttributes: attributes).height
            let rect = CGRect(
                x: 0,
                y: background.size.height * 0.22 - textHeight / 2,
                width: background.size.width,
                height: textHeight
            )
            label.draw(in: rect, withAttributes: attributes)
        }
    }
}

/// A `DefaultMarkerIcon`-style (color, no background image) cluster icon.
private struct ColorClusterIconOptions {
    let fillColor: UIColor
    let strokeColor: UIColor
    let strokeWidth: CGFloat
    let scale: CGFloat
    let labelTextColor: UIColor?
    let labelTextSize: CGFloat
    let labelStrokeColor: UIColor
    let iconSize: CGFloat
    let debug: Bool

    static func decode(_ map: [String: Any]?) -> ColorClusterIconOptions? {
        guard let map else { return nil }
        return ColorClusterIconOptions(
            fillColor: mcColor(css: map["fillColor"], default: .red) ?? .red,
            strokeColor: mcColor(css: map["strokeColor"], default: .white) ?? .white,
            strokeWidth: CGFloat(mcDouble(map["strokeWidth"], default: 1.0)),
            scale: CGFloat(mcDouble(map["scale"], default: 1.0)),
            labelTextColor: mcColor(css: map["labelTextColor"], default: .black),
            labelTextSize: CGFloat(mcDouble(map["labelTextSize"], default: 18.0)),
            labelStrokeColor: mcColor(css: map["labelStrokeColor"], default: .white) ?? .white,
            iconSize: CGFloat(mcDouble(map["iconSize"], default: 48.0)),
            debug: mcBool(map["debug"], default: false)
        )
    }

    var iconProvider: MarkerClusterGroupState.ClusterIconProvider {
        { count in
            DefaultMarkerIcon(
                fillColor: self.fillColor,
                strokeColor: self.strokeColor,
                strokeWidth: self.strokeWidth,
                scale: self.scale,
                label: "\(count)",
                labelTextColor: self.labelTextColor,
                labelTextSize: self.labelTextSize,
                labelStrokeColor: self.labelStrokeColor,
                infoAnchor: CGPoint(x: 0.5, y: 0),
                iconSize: self.iconSize,
                debug: self.debug
            )
        }
    }
}
