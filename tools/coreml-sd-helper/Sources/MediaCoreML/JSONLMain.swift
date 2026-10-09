import Foundation
import MediaCoreMLCore
import Darwin

// The legacy one-shot code in main.swift declares its own HelperError; the library type is always module-qualified here.
private let emitLock = NSLock()
private func writeLine(_ message: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys]) else { return }
    emitLock.lock(); defer { emitLock.unlock() }
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}

/// `media-coreml --capabilities`: what a supervising parent probes before choosing the protocol.
let capabilitiesJSON = #"{"ops":["generate","img2img","list-models","cancel"],"protocol":"jsonl/1"}"#

/// `media-coreml --jsonl`: serve requests until stdin closes. SIGTERM ends the process at once; the parent cleans its temp files.
func runJSONL() -> Never {
    #if arch(arm64)
    guard #available(macOS 13.1, *) else { writeLine(["type": "error", "code": MediaCoreMLCore.HelperError.backend.code]); exit(1) }
    signal(SIGTERM) { _ in _exit(143) }
    signal(SIGINT) { _ in _exit(130) }
    let models = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("MochiDiffusion/models")
    let session = JSONLSession(backend: AppleBackend(), defaultModelsDir: models, emit: writeLine)
    while let line = readLine(strippingNewline: true) {
        guard line.utf8.count <= 1_048_576 else { writeLine(["type": "error", "code": MediaCoreMLCore.HelperError.invalidRequest.code]); continue }
        session.handle(line: Data(line.utf8))
    }
    session.drain()
    exit(0)
    #else
    writeLine(["type": "error", "code": MediaCoreMLCore.HelperError.backend.code]); exit(1)
    #endif
}
