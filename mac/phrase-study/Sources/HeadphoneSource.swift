import CoreMotion
import Foundation
import Observation
import OSLog

@MainActor @Observable
final class HeadphoneSource: NSObject, CMHeadphoneMotionManagerDelegate {
    private(set) var headphones = "disconnected"
    private(set) var auth = "notDetermined"
    private(set) var loc = "unknown"
    private(set) var hz = 0.0
    private(set) var gapPct = 0.0
    private(set) var lastError = ""
    @ObservationIgnored var onSample: ((MotionFrame) -> Void)?
    @ObservationIgnored var onStateChange: (() -> Void)?
    @ObservationIgnored private let manager = CMHeadphoneMotionManager()
    @ObservationIgnored private let queue: OperationQueue = {
        let queue = OperationQueue()
        queue.name = "PhraseMotionBridge.headphones"
        queue.maxConcurrentOperationCount = 1
        return queue
    }()
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var seq = 0
    @ObservationIgnored private var readings: [(arrival: Double, t: Double)] = []
    @ObservationIgnored private var lastArrival = 0.0
    @ObservationIgnored private var lastRestart = 0.0
    @ObservationIgnored private var bootstrapStarted = 0.0
    @ObservationIgnored private var running = false
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var disconnectedAt = 0.0
    @ObservationIgnored private let log = Logger(subsystem: "com.martechia.PhraseMotionBridge", category: "HeadphoneMotion")

    var connectionText: String {
        headphones == "connected" ? "Receiving live motion" : "Waiting for live motion"
    }

    func start() {
        log.info("Starting real headphone motion")
        manager.delegate = self
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        restart()
    }

    func stop() {
        generation += 1
        running = false
        timer?.invalidate()
        timer = nil
        manager.delegate = nil
        manager.stopDeviceMotionUpdates()
        headphones = "disconnected"
        hz = 0
    }

    func restart() {
        log.info("Restart requested. available=\(self.manager.isDeviceMotionAvailable) active=\(self.manager.isDeviceMotionActive)")
        generation += 1
        manager.stopDeviceMotionUpdates()
        running = false
        lastRestart = ProcessInfo.processInfo.systemUptime
        bootstrapStarted = lastRestart
        readings.removeAll()
        lastArrival = 0
        hz = 0
        gapPct = 0
        headphones = manager.isDeviceMotionAvailable ? "disconnected" : "unavailable"
        loc = "unknown"
        refreshAuthorization()
        onStateChange?()
        beginUpdates()
    }

    private func beginUpdates() {
        guard !running, !manager.isDeviceMotionActive else { return }
        guard manager.isDeviceMotionAvailable, auth != "denied", auth != "restricted" else { return }
        generation += 1
        running = true
        log.info("Starting update subscription. permission=\(self.auth, privacy: .public)")
        let generation = generation
        let handler = MotionCallback.make { [weak self] reading, message, arrival in
            guard let self else { return }
            guard self.generation == generation, self.running else { return }
            if let reading { self.accept(reading, arrival: arrival) }
            else if let message {
                if self.lastError != message { self.log.error("Motion callback error: \(message, privacy: .public)") }
                self.lastError = message
            }
        }
        manager.startDeviceMotionUpdates(to: queue, withHandler: handler)
    }

    private func accept(_ reading: HeadphoneReading, arrival: Double) {
        guard running, arrival >= disconnectedAt else { return }
        guard ([reading.t] + reading.q + reading.rr + reading.ua + reading.g).allSatisfy(\.isFinite) else {
            lastError = "Invalid motion sample; reconnect the AirPods."
            return
        }
        if let previous = readings.last, reading.t <= previous.t {
            readings.removeAll()
        }
        lastArrival = arrival
        readings.append((arrival, reading.t))
        if readings.count > 1000 { readings.removeFirst(readings.count - 1000) }
        let changed = headphones != "connected" || loc != reading.loc
        if changed { log.info("Receiving real samples. sensor=\(reading.loc, privacy: .public)") }
        headphones = "connected"
        loc = reading.loc
        lastError = ""
        if changed { onStateChange?() }
        onSample?(MotionFrame(seq: seq, t: reading.t, q: reading.q, rr: reading.rr, ua: reading.ua, g: reading.g))
        seq += 1
    }

    private func tick() {
        refreshAuthorization()
        let now = ProcessInfo.processInfo.systemUptime
        readings.removeAll { $0.arrival < now - 10 }
        hz = Double(readings.filter { $0.arrival >= now - 2 }.count) / 2
        let gaps = zip(readings, readings.dropFirst()).filter { $1.t - $0.t > 0.06 }.count
        gapPct = readings.count > 1 ? 100 * Double(gaps) / Double(readings.count - 1) : 0
        if now - lastArrival > 1 {
            headphones = manager.isDeviceMotionAvailable ? "disconnected" : "unavailable"
            hz = 0
        }
        onStateChange?()
        // Route changes and the first authorized subscription can take longer
        // than a normal stream interruption. Give them one uninterrupted window
        // instead of repeatedly cancelling a subscription that is still starting.
        let stalled = lastArrival == 0 ? now - bootstrapStarted > 30 : now - lastArrival > 5
        if stalled, now - lastRestart > 5,
           manager.isDeviceMotionAvailable, auth != "denied", auth != "restricted" {
            if lastArrival == 0 { log.info("No first sample after 30-second bootstrap grace; retrying subscription") }
            else { log.info("Live motion stalled for 5 seconds; retrying subscription") }
            restart()
        }
    }

    private func refreshAuthorization() {
        let previous = auth
        switch CMHeadphoneMotionManager.authorizationStatus() {
        case .authorized: auth = "authorized"
        case .denied: auth = "denied"
        case .restricted: auth = "restricted"
        case .notDetermined: auth = "notDetermined"
        @unknown default: auth = "restricted"
        }
        if auth != previous { log.info("Motion authorization=\(self.auth, privacy: .public)") }
    }

    nonisolated func headphoneMotionManagerDidConnect(_ manager: CMHeadphoneMotionManager) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.log.info("Core Motion connected. active=\(self.manager.isDeviceMotionActive)")
            if self.lastArrival == 0 {
                self.bootstrapStarted = ProcessInfo.processInfo.systemUptime
                self.log.info("Waiting up to 30 seconds for the first real sample")
            }
            // Starting updates itself produces a connect notification. Stopping here
            // creates a connect -> stop -> disconnect loop before any sample arrives.
            if !self.running && !self.manager.isDeviceMotionActive { self.beginUpdates() }
        }
    }

    nonisolated func headphoneMotionManagerDidDisconnect(_ manager: CMHeadphoneMotionManager) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.log.info("Core Motion disconnected. active=\(self.manager.isDeviceMotionActive)")
            // Keep the subscription alive: Core Motion can resume it on reconnect.
            // Reject callbacks queued before this disconnect instead of restarting
            // from inside its lifecycle callback.
            self.disconnectedAt = ProcessInfo.processInfo.systemUptime
            self.bootstrapStarted = self.disconnectedAt
            self.lastArrival = 0
            self.readings.removeAll()
            self.headphones = "disconnected"
            self.loc = "unknown"
            self.hz = 0
            self.onStateChange?()
        }
    }
}
