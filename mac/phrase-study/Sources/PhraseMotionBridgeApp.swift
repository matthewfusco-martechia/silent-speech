import SwiftUI

@main
struct PhraseMotionBridgeApp: App {
    @NSApplicationDelegateAdaptor(PhraseAppDelegate.self) private var appDelegate
    @State private var bridge = PhraseBridgeModel()

    var body: some Scene {
        Window("Phrase Motion Bridge", id: "main") {
            BridgeView(bridge: bridge, appDelegate: appDelegate)
        }
        .defaultSize(width: 460, height: 390)
        .windowResizability(.contentSize)
    }
}
