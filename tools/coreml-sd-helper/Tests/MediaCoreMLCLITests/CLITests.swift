import Testing
import Foundation

// These run the built `media-coreml` executable (`swift build` first). They pin the one-shot protocol (v1) that
// existing callers rely on, and check the new --capabilities / --jsonl switches end to end without any model.

func builtBinary() -> URL? {
    let fm = FileManager.default
    var candidates = Bundle.allBundles.filter { $0.bundlePath.hasSuffix(".xctest") }.map { $0.bundleURL.deletingLastPathComponent().appendingPathComponent("media-coreml") }
    candidates.append(URL(fileURLWithPath: fm.currentDirectoryPath).appendingPathComponent(".build/debug/media-coreml"))
    return candidates.first { fm.isExecutableFile(atPath: $0.path) }
}
let binaryAvailable = builtBinary() != nil

struct Run { let status: Int32; let lines: [String] }
func run(_ arguments: [String], stdin: String) throws -> Run {
    let process = Process(); process.executableURL = builtBinary(); process.arguments = arguments; process.environment = [:]
    let input = Pipe(), output = Pipe(); process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
    try process.run()
    input.fileHandleForWriting.write(Data(stdin.utf8)); try input.fileHandleForWriting.close()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return Run(status: process.terminationStatus, lines: String(decoding: data, as: UTF8.self).split(separator: "\n").map(String.init))
}
func modelsDir() throws -> URL {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("media-coreml-cli-\(UUID().uuidString)")
    for name in ["TextEncoder.mlmodelc", "Unet.mlmodelc", "VAEDecoder.mlmodelc"] { try FileManager.default.createDirectory(at: root.appendingPathComponent("sd-split").appendingPathComponent(name), withIntermediateDirectories: true) }
    return root
}

@Suite(.enabled(if: binaryAvailable, "build the executable first: swift build")) struct CLITests {
    @Test func capabilitiesAnnounceTheJSONLProtocol() throws {
        let r = try run(["--capabilities"], stdin: "")
        #expect(r.status == 0)
        let caps = try #require(try JSONSerialization.jsonObject(with: Data((r.lines.first ?? "").utf8)) as? [String: Any])
        #expect(caps["protocol"] as? String == "jsonl/1")
        #expect((caps["ops"] as? [String])?.sorted() == ["cancel", "generate", "img2img", "list-models"])
        #expect(try run(["--version"], stdin: "").lines.first?.hasPrefix("media-coreml 2") == true)
    }

    @Test func theOneShotProtocolIsUnchanged() throws {
        let dir = try modelsDir()
        let list = try run([], stdin: #"{"operation":"list","model":"x","modelDir":"\#(dir.path)","outputDir":"/tmp/unused"}"# + "\n")
        #expect(list.status == 0)
        #expect(list.lines == [#"{"models":["sd-split"],"type":"models"}"#])
        let unknown = try run([], stdin: #"{"operation":"generate","model":"nope","modelDir":"\#(dir.path)","outputDir":"/tmp/unused","request":{"prompt":"x"}}"# + "\n")
        #expect(unknown.status == 1)
        #expect(unknown.lines == [#"{"code":"backend_unavailable","type":"error"}"#])
        let garbage = try run([], stdin: "not json")
        #expect(garbage.status == 1 && garbage.lines == [#"{"code":"backend_unavailable","type":"error"}"#])
    }

    @Test func jsonlServesRequestsUntilStdinClosesAndExitsCleanly() throws {
        let dir = try modelsDir()
        let r = try run(["--jsonl"], stdin: [
            #"{"id":"1","op":"list-models","modelsDir":"\#(dir.path)"}"#,
            #"{"id":"2","op":"generate","model":"missing","modelsDir":"\#(dir.path)","outputDir":"/tmp/media-coreml-unused","request":{"prompt":"x"}}"#,
            "{broken",
        ].joined(separator: "\n") + "\n")
        #expect(r.status == 0)
        #expect(r.lines.count == 3)
        #expect(r.lines.contains(#"{"id":"1","models":["sd-split"],"type":"models"}"#))
        #expect(r.lines.contains(#"{"code":"model_not_found","id":"2","type":"error"}"#))
        #expect(r.lines.contains(#"{"code":"invalid_request","type":"error"}"#))
    }
}
