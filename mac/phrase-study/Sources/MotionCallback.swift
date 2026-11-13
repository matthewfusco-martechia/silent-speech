import CoreMotion
import Foundation

/// Core Motion invokes handlers on its supplied OperationQueue. Its SDK block is
/// not Sendable-annotated, so an inline handler created on MainActor can inherit
/// MainActor isolation and trap before its body executes on that background queue.
enum MotionCallback {
    typealias Handler = @Sendable (CMDeviceMotion?, (any Error)?) -> Void

    nonisolated static func make(
        deliver: @escaping @MainActor @Sendable (HeadphoneReading?, String?, Double) -> Void
    ) -> Handler {
        { @Sendable motion, error in
            let reading: HeadphoneReading?
            if let motion { reading = HeadphoneReading(motion) }
            else { reading = nil }
            let message = error?.localizedDescription
            let arrival = ProcessInfo.processInfo.systemUptime
            Task { @MainActor in deliver(reading, message, arrival) }
        }
    }
}
