# Phrase Motion Bridge

This standalone target supplies real AirPods head motion to the local phrase study.
It links only Core Motion, Network, Foundation, AppKit, Observation, OSLog and SwiftUI.
There is no audio engine, microphone/camera capture, speech output, simulated motion,
or action runner in this target. The app asks only for Motion permission.

Build from the repository root:

```sh
mac/phrase-study/build.sh
scripts/launch-phrase-study.sh
```

The app is built in the workspace next to the checkout at
`../phrase-study-build/Build/Products/Debug/PhraseMotionBridge.app`. It uses a separate
bundle ID (`com.martechia.PhraseMotionBridge`) and does not access the original
bridge's pairing, actions, or configuration files. No raw recordings are stored
by the bridge; the study page handles explicit labeled capture and local storage.
Closing the bridge window keeps its motion subscription and server alive; Quit
stops both. Clicking the Dock icon reopens the bridge window.

The dashboard is `http://127.0.0.1:5173/silent-speech/study.html`. The read-only
WebSocket binds to `127.0.0.1:8766`, accepts only the exact localhost/127.0.0.1 port
5173 browser origins, and rejects connections with missing Origin headers. It emits
upstream protocol-v1 `hello`, `status`, and `motion` frames. `hello.actions` is empty,
`armed` is always false and `simulated` is always false. Client messages cannot
invoke an OS action. No hosted page or fallback/replay source is used.

Keep the AirPods in your ears and selected as the Mac's audio output. macOS can
deliver motion from either ear; the reported sensor location accompanies the
stream. Connection status is "connected" only while fresh real samples arrive;
stalls/disconnections close readiness. Initial/reconnected subscriptions get
30 seconds for their first real sample before retrying; an established stream
is restarted after a five-second stall. This prevents a slow Bluetooth route
transition from being interrupted repeatedly during startup.

After opening the app, the read-only wire check can verify Origin and action
rejection without starting any labeled capture:

```sh
node mac/phrase-study/check-wire.mjs
```

The callback regression executes the same explicitly Sendable callback factory on
a background OperationQueue, then verifies delivery reaches MainActor. It guards
against inheriting UI isolation into Core Motion's unannotated SDK callback:

```sh
mac/phrase-study/check-callback.sh
```

The launcher never kills a process using port 5173. It only reuses a server whose
study page carries the local phrase-study marker. Other applications on that port
must be moved or quit explicitly. Launcher logs/PID are local workspace artifacts
outside the checkout, with owner-only access.
