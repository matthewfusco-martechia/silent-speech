import AppKit
import Observation

@MainActor @Observable
final class PhraseBridgeModel {
    let motion: HeadphoneSource
    let server: MotionServer
    @ObservationIgnored private var activity: NSObjectProtocol?

    init() {
        let motion = HeadphoneSource()
        self.motion = motion
        server = MotionServer(motion: motion)
        activity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiated], reason: "Streaming local AirPods motion for a silent phrase study"
        )
        server.start()
        motion.start()
    }

    func reconnect() {
        motion.restart()
    }

    func stop() {
        motion.stop()
        server.stop()
        if let activity { ProcessInfo.processInfo.endActivity(activity) }
        activity = nil
    }

    func openStudy() {
        guard let url = URL(string: "http://127.0.0.1:5173/silent-speech/study.html") else { return }
        NSWorkspace.shared.open(url)
    }
}
