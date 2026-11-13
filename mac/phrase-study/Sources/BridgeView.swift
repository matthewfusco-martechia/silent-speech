import SwiftUI

struct BridgeView: View {
    @Environment(\.openWindow) private var openWindow
    let bridge: PhraseBridgeModel
    let appDelegate: PhraseAppDelegate

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label("Silent phrase study", systemImage: "headphones")
                .font(.title2.weight(.semibold))
            Text("AirPods motion stays on this Mac. Follow the visual cues in the phrase study.")
                .foregroundStyle(.secondary)
            Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 10) {
                GridRow { Text("AirPods"); Text(bridge.motion.connectionText).fontWeight(.medium) }
                GridRow { Text("Motion permission"); Text(bridge.motion.auth) }
                GridRow { Text("Motion rate"); Text(bridge.motion.hz, format: .number.precision(.fractionLength(0))) + Text(" Hz") }
                GridRow { Text("Sensor ear"); Text(bridge.motion.loc) }
                GridRow { Text("Study connection"); Text(bridge.server.listening ? "Ready" : "Waiting") }
            }
            Text(bridge.server.message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            if !bridge.motion.lastError.isEmpty {
                Text(bridge.motion.lastError).font(.caption).foregroundStyle(.orange)
            }
            HStack {
                Button("Open phrase study", systemImage: "arrow.up.right.square", action: bridge.openStudy)
                    .buttonStyle(.borderedProminent)
                Button("Reconnect AirPods", action: bridge.reconnect)
                    .buttonStyle(.bordered)
            }
            Text("Keep AirPods in your ears and selected as the Mac’s audio output. Grant Motion if macOS asks.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(26)
        .frame(width: 460)
        .onAppear {
            appDelegate.onReopen = { openWindow(id: "main") }
            appDelegate.onTerminate = bridge.stop
        }
    }
}
