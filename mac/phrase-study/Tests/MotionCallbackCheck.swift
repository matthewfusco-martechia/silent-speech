import CoreMotion
import Foundation

@main
struct MotionCallbackCheck {
    @MainActor
    static func main() async {
        let queue = OperationQueue()
        queue.name = "PhraseMotionBridge.callback-regression"
        queue.maxConcurrentOperationCount = 1
        let expected = "Background callback reached MainActor"
        let result: (String?, Double) = await withCheckedContinuation { continuation in
            // Construct in MainActor context, like HeadphoneSource.beginUpdates.
            let handler = MotionCallback.make { reading, message, arrival in
                MainActor.assertIsolated()
                precondition(reading == nil)
                continuation.resume(returning: (message, arrival))
            }
            queue.addOperation {
                precondition(!Thread.isMainThread)
                handler(nil, NSError(domain: "MotionCallbackRegression", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: expected]))
            }
        }
        precondition(result.0 == expected)
        precondition(result.1 > 0)
        print("PASS: real callback factory invoked on background OperationQueue delivers on MainActor without isolation trap")
    }
}
