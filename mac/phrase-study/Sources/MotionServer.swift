import Foundation
import Network
import Observation

/// A read-only protocol-v1 motion endpoint. No action runner or audio code is linked to this target.
@MainActor @Observable
final class MotionServer {
    private(set) var listening = false
    private(set) var message = "Starting local study connection…"
    private(set) var clientCount = 0
    @ObservationIgnored private let motion: HeadphoneSource
    @ObservationIgnored private var listener: NWListener?
    @ObservationIgnored private var clients: [ObjectIdentifier: Client] = [:]
    @ObservationIgnored private var approvals: [Double] = []
    @ObservationIgnored private var retryScheduled = false
    nonisolated static let port: UInt16 = 8766
    nonisolated static let origins: Set<String> = ["http://127.0.0.1:5173", "http://localhost:5173"]

    @MainActor private final class Client {
        let connection: NWConnection
        var ready = false
        var closing = false
        var pendingFrames = 0
        var receivedMessages = 0
        init(_ connection: NWConnection) { self.connection = connection }
    }

    init(motion: HeadphoneSource) { self.motion = motion }

    func start() {
        motion.onSample = { [weak self] sample in
            guard let data = try? JSONEncoder().encode(sample) else { return }
            self?.broadcast(data)
        }
        motion.onStateChange = { [weak self] in self?.broadcastStatus() }
        openListener()
    }

    func stop() {
        listener?.cancel()
        listener = nil
        for client in Array(clients.values) { remove(client) }
        listening = false
    }

    private func openListener() {
        guard listener == nil else { return }
        let webSocket = NWProtocolWebSocket.Options()
        webSocket.autoReplyPing = true
        webSocket.maximumMessageSize = 8 * 1024
        webSocket.setClientRequestHandler(.main) { [weak self] _, headers in
            MainActor.assumeIsolated {
                let origins = headers.filter { $0.name.lowercased() == "origin" }
                let allowed = origins.count == 1 && Self.origins.contains(origins[0].value.trimmingCharacters(in: .whitespaces))
                if allowed {
                    self?.approvals.removeAll { $0 < ProcessInfo.processInfo.systemUptime - 5 }
                    self?.approvals.append(ProcessInfo.processInfo.systemUptime)
                }
                return NWProtocolWebSocket.Response(status: allowed ? .accept : .reject, subprotocol: nil)
            }
        }
        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .loopback
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: Self.port)!)
        parameters.defaultProtocolStack.applicationProtocols.insert(webSocket, at: 0)
        do {
            let current = try NWListener(using: parameters)
            current.stateUpdateHandler = { [weak self, weak current] state in
                Task { @MainActor in
                    guard let self, let current, self.listener === current else { return }
                    self.listenerChanged(state)
                }
            }
            current.newConnectionHandler = { [weak self] connection in
                Task { @MainActor in self?.accept(connection) }
            }
            listener = current
            current.start(queue: .main)
        } catch {
            message = "Could not open the local connection. \(error.localizedDescription)"
            scheduleRetry()
        }
    }

    private func listenerChanged(_ state: NWListener.State) {
        switch state {
        case .ready:
            listening = true
            message = "Local connection ready · 127.0.0.1:\(Self.port)"
        case .failed(let error):
            listening = false
            message = "Local connection unavailable. \(error.localizedDescription)"
            listener?.cancel()
            listener = nil
            scheduleRetry()
        case .waiting(let error):
            listening = false
            message = "Waiting for the local connection. \(error.localizedDescription)"
        case .cancelled:
            listening = false
        default: break
        }
    }

    private func scheduleRetry() {
        guard !retryScheduled else { return }
        retryScheduled = true
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self else { return }
            self.retryScheduled = false
            self.openListener()
        }
    }

    private func accept(_ connection: NWConnection) {
        guard Self.isLoopback(connection.endpoint), clients.count < 8 else { connection.cancel(); return }
        let client = Client(connection)
        clients[ObjectIdentifier(connection)] = client
        connection.stateUpdateHandler = { [weak self, weak client] state in
            Task { @MainActor in
                guard let self, let client else { return }
                switch state {
                case .ready:
                    guard !client.ready else { return }
                    self.approvals.removeAll { $0 < ProcessInfo.processInfo.systemUptime - 5 }
                    guard !self.approvals.isEmpty else { self.remove(client); return }
                    self.approvals.removeFirst()
                    client.ready = true
                    self.clientCount = self.clients.values.filter(\.ready).count
                    self.sendJSON(["type": "hello", "v": 1, "app": "PhraseMotionBridge", "version": "0.1.0",
                                   "actions": [], "armed": false], to: client)
                    self.sendJSON(self.status(), to: client)
                    self.receive(client)
                case .failed, .cancelled:
                    self.remove(client)
                case .waiting:
                    self.remove(client)
                default: break
                }
            }
        }
        connection.start(queue: .main)
        Task { @MainActor [weak self, weak client] in
            try? await Task.sleep(for: .seconds(5))
            guard let self, let client, !client.ready else { return }
            self.remove(client)
        }
    }

    nonisolated private static func isLoopback(_ endpoint: NWEndpoint) -> Bool {
        guard case .hostPort(let host, _) = endpoint else { return false }
        switch host {
        case .ipv4(let address): return address == .loopback
        case .ipv6(let address): return address == .loopback || address.rawValue == Data([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 127, 0, 0, 1])
        case .name(let name, _): return name == "127.0.0.1" || name == "::1"
        @unknown default: return false
        }
    }

    private func receive(_ client: Client) {
        client.connection.receiveMessage { [weak self, weak client] data, context, _, error in
            let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            let closed = metadata?.opcode == .close || error != nil || (data == nil && context?.isFinal == true)
            Task { @MainActor in
                guard let self, let client, client.ready else { return }
                if closed { self.close(client); return }
                if let data, !data.isEmpty {
                    client.receivedMessages += 1
                    guard client.receivedMessages <= 16 else { self.close(client); return }
                    self.sendJSON(["type": "error", "code": "unknown_action",
                                   "message": "This bridge provides motion only. Actions are unavailable."], to: client)
                }
                self.receive(client)
            }
        }
    }

    private func close(_ client: Client) {
        guard !client.closing else { return }
        client.closing = true
        let metadata = NWProtocolWebSocket.Metadata(opcode: .close)
        metadata.closeCode = .protocolCode(.normalClosure)
        let context = NWConnection.ContentContext(identifier: "close", metadata: [metadata])
        let connection = client.connection
        connection.send(content: nil, contentContext: context, isComplete: true, completion: .contentProcessed { _ in connection.cancel() })
        Task { @MainActor [weak self, weak client] in
            try? await Task.sleep(for: .seconds(1))
            guard let self, let client else { return }
            self.remove(client)
        }
    }

    private func remove(_ client: Client) {
        client.connection.stateUpdateHandler = nil
        client.connection.cancel()
        clients.removeValue(forKey: ObjectIdentifier(client.connection))
        client.ready = false
        clientCount = clients.values.filter(\.ready).count
    }

    private func status() -> [String: Any] {
        ["type": "status", "headphones": motion.headphones, "auth": motion.auth, "loc": motion.loc,
         "hz": motion.hz, "gapPct": motion.gapPct, "clients": clientCount, "armed": false, "simulated": false]
    }

    private func broadcastStatus() {
        guard let data = try? JSONSerialization.data(withJSONObject: status()) else { return }
        broadcast(data)
    }

    private func broadcast(_ data: Data) {
        for client in Array(clients.values) where client.ready { send(data, to: client) }
    }

    private func sendJSON(_ value: [String: Any], to client: Client) {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        send(data, to: client)
    }

    private func send(_ data: Data, to client: Client) {
        guard client.ready, !client.closing else { return }
        guard client.pendingFrames < 250 else { remove(client); return }
        client.pendingFrames += 1
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "motion", metadata: [metadata])
        client.connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { [weak self, weak client] error in
            Task { @MainActor in
                guard let self, let client else { return }
                client.pendingFrames -= 1
                if error != nil { self.remove(client) }
            }
        })
    }
}
