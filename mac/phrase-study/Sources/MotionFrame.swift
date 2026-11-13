import Foundation

struct MotionFrame: Encodable, Sendable {
    let type = "motion"
    let seq: Int
    let t: Double
    let q: [Double]
    let rr: [Double]
    let ua: [Double]
    let g: [Double]
}
