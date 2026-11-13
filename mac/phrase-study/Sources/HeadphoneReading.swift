import CoreMotion

/// Copy Core Motion's values on its serial callback queue before crossing actors.
struct HeadphoneReading: Sendable {
    let t: Double
    let q: [Double]
    let rr: [Double]
    let ua: [Double]
    let g: [Double]
    let loc: String

    nonisolated init(_ m: CMDeviceMotion) {
        t = m.timestamp
        let q = m.attitude.quaternion
        self.q = [q.w, q.x, q.y, q.z]
        rr = [m.rotationRate.x, m.rotationRate.y, m.rotationRate.z]
        ua = [m.userAcceleration.x, m.userAcceleration.y, m.userAcceleration.z]
        g = [m.gravity.x, m.gravity.y, m.gravity.z]
        switch m.sensorLocation {
        case .headphoneLeft: loc = "left"
        case .headphoneRight: loc = "right"
        case .default: loc = "default"
        @unknown default: loc = "unknown"
        }
    }
}
