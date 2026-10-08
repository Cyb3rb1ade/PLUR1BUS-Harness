import Testing
import Foundation
@testable import MediaCoreMLCore

@Suite struct SessionTests {
    let backend = FakeBackend()
    let events = Events()
    let models: URL
    let output: URL
    let session: JSONLSession

    init() {
        models = makeTree(complete("sd-split_einsum") + complete("sd-original", encoder: true))
        output = FileManager.default.temporaryDirectory.appendingPathComponent("media-coreml-out-\(UUID().uuidString)")
        let events = self.events
        session = JSONLSession(backend: backend, defaultModelsDir: models, randomSeed: { 4242 }, emit: { events.add($0) })
    }

    func generate(_ id: String, op: String = "generate", model: String = "sd-split_einsum", request: [String: Any] = ["prompt": "a tree"], extra: [String: Any] = [:]) {
        var wire: [String: Any] = ["id": id, "op": op, "model": model, "modelsDir": models.path, "outputDir": output.appendingPathComponent(id).path, "request": request]
        for (k, v) in extra { wire[k] = v }
        session.handle(line: json(wire))
    }
    func code(_ id: String) -> String? { events.last(id)?["code"] as? String }

    @Test func generateReportsProgressWritesPrivateFilesAndEchoesTheSeed() throws {
        generate("1", request: ["prompt": "a tree", "negativePrompt": "fog", "n": 2, "seed": 7, "steps": 12, "guidance": 6.5, "scheduler": "dpmpp"])
        session.drain()
        #expect(events.types("1") == ["progress", "progress", "result"])
        let result = try #require(events.last("1"))
        #expect(result["files"] as? [String] == ["0.png", "1.png"])
        #expect(result["seed"] as? Int == 7)
        let job = try #require(backend.jobs.first)
        #expect(job.prompt == "a tree" && job.negativePrompt == "fog" && job.imageCount == 2 && job.seed == 7 && job.steps == 12 && job.guidance == 6.5 && job.scheduler == "dpmpp")
        #expect(job.startingImage == nil && job.strength == nil)
        for name in ["0.png", "1.png"] {
            let path = output.appendingPathComponent("1").appendingPathComponent(name).path
            let permissions = try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? Int
            #expect(permissions == 0o600)
        }
    }

    @Test func aMissingSeedIsDrawnOnceAndReported() throws {
        generate("1")
        session.drain()
        #expect(backend.jobs.first?.seed == 4242)
        #expect(events.last("1")?["seed"] as? Int == 4242)
    }

    @Test func computeUnitsFollowTheModelUnlessTheCallerChoosesThem() {
        generate("a"); generate("b", model: "sd-original"); generate("c", extra: ["computeUnits": "all"])
        session.drain()
        #expect(backend.jobs.map { $0.computeUnits } == [.cpuAndNeuralEngine, .cpuAndGPU, .all])
        generate("d", extra: ["computeUnits": "gpu"])
        session.drain()
        #expect(code("d") == "invalid_request")
    }

    @Test func img2imgReadsTheReferenceAndKeepsStrength() throws {
        let input = output.deletingLastPathComponent().appendingPathComponent("input-\(UUID().uuidString).png")
        try Data([1, 2, 3]).write(to: input)
        generate("1", op: "img2img", model: "sd-original", request: ["prompt": "snow", "strength": 0.5], extra: ["inputPath": input.path])
        session.drain()
        #expect(events.types("1").last == "result")
        let job = try #require(backend.jobs.first)
        #expect(job.startingImage == Data([1, 2, 3]) && job.strength == 0.5)
    }

    @Test func img2imgNeedsAnEncoderARegularFileAndASaneStrength() throws {
        let input = output.deletingLastPathComponent().appendingPathComponent("input-\(UUID().uuidString).png")
        try Data([1]).write(to: input)
        let link = output.deletingLastPathComponent().appendingPathComponent("link-\(UUID().uuidString).png")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: input)
        generate("no-encoder", op: "img2img", model: "sd-split_einsum", extra: ["inputPath": input.path])
        generate("symlink", op: "img2img", model: "sd-original", extra: ["inputPath": link.path])
        generate("missing", op: "img2img", model: "sd-original", extra: ["inputPath": "/nonexistent/x.png"])
        generate("relative", op: "img2img", model: "sd-original", extra: ["inputPath": "x.png"])
        generate("no-path", op: "img2img", model: "sd-original")
        generate("strength", op: "img2img", model: "sd-original", request: ["prompt": "x", "strength": 1.5], extra: ["inputPath": input.path])
        generate("zero", op: "img2img", model: "sd-original", request: ["prompt": "x", "strength": 0], extra: ["inputPath": input.path])
        generate("strength-on-txt", request: ["prompt": "x", "strength": 0.5])
        session.drain()
        for id in ["no-encoder", "symlink", "missing", "relative", "no-path", "strength", "zero", "strength-on-txt"] { #expect(code(id) == "invalid_request", "\(id)") }
        #expect(backend.jobs.isEmpty)
    }

    @Test func listModelsAnswersFromTheModelsDirectoryAndToleratesAMissingOne() {
        session.handle(line: json(["id": "l1", "op": "list-models", "modelsDir": models.path]))
        session.handle(line: json(["id": "l2", "op": "list-models", "modelsDir": "/nonexistent/\(UUID().uuidString)"]))
        session.handle(line: json(["id": "l3", "op": "list-models"]))
        session.drain()
        #expect(events.last("l1")?["models"] as? [String] == ["sd-original", "sd-split_einsum"])
        #expect(events.last("l2")?["models"] as? [String] == [])
        #expect(events.last("l3")?["models"] as? [String] == ["sd-original", "sd-split_einsum"])
    }

    @Test func cancelStopsTheRunningJobAtTheNextStepAndTheSessionSurvives() {
        backend.gate = DispatchSemaphore(value: 0)
        generate("1")
        backend.started.wait()
        session.handle(line: json(["op": "cancel", "target": "1"]))
        backend.gate!.signal()
        session.drain()
        #expect(code("1") == "cancelled")
        #expect(!FileManager.default.fileExists(atPath: output.appendingPathComponent("1").path))
        backend.gate = nil
        generate("2")
        session.drain()
        #expect(events.types("2").last == "result")
    }

    @Test func cancelDropsAQueuedJobBeforeItStarts() {
        backend.gate = DispatchSemaphore(value: 0)
        generate("first")
        backend.started.wait()
        generate("second")
        session.handle(line: json(["op": "cancel", "target": "second"]))
        backend.gate!.signal()
        session.drain()
        #expect(events.types("first").last == "result")
        #expect(code("second") == "cancelled")
        #expect(backend.jobs.count == 1)
    }

    @Test func aCancelForAnUnknownOrFinishedIdChangesNothing() {
        session.handle(line: json(["op": "cancel", "target": "never-seen"]))
        generate("1")
        session.drain()
        session.handle(line: json(["op": "cancel", "target": "1"]))
        generate("1")  // the id may be reused after completion and must not inherit the old cancel
        session.drain()
        #expect(events.of("1").filter { $0["type"] as? String == "result" }.count == 2)
    }

    @Test func aRefusedImageIsContentPolicyAndNothingIsWritten() {
        backend.images = { _ in [Data([1]), nil] }
        generate("1", request: ["prompt": "x", "n": 2])
        backend.images = { _ in [] }
        generate("2")
        session.drain()
        #expect(code("1") == "content_policy" && code("2") == "content_policy")
        #expect(!FileManager.default.fileExists(atPath: output.appendingPathComponent("1").path))
    }

    @Test func invalidRequestsAreRefusedWithoutTouchingTheBackend() {
        generate("blank", request: ["prompt": "   "])
        generate("n0", request: ["prompt": "x", "n": 0]); generate("n11", request: ["prompt": "x", "n": 11])
        generate("steps0", request: ["prompt": "x", "steps": 0]); generate("steps1001", request: ["prompt": "x", "steps": 1001])
        generate("seed", request: ["prompt": "x", "seed": 4294967296])
        generate("relative-out", extra: ["outputDir": "relative/dir"])
        generate("no-request", extra: ["request": NSNull()])
        session.handle(line: json(["id": "no-model", "op": "generate", "modelsDir": models.path, "outputDir": output.path, "request": ["prompt": "x"]]))
        session.drain()
        for id in ["blank", "n0", "n11", "steps0", "steps1001", "seed", "relative-out", "no-request", "no-model"] { #expect(code(id) == "invalid_request", "\(id)") }
        generate("ghost", model: "nope"); generate("traversal", model: "../sd-original")
        session.drain()
        #expect(code("ghost") == "model_not_found" && code("traversal") == "model_not_found")
        #expect(backend.jobs.isEmpty)
    }

    @Test func malformedLinesAndUnknownOperationsGetAnErrorEvent() {
        session.handle(line: Data("{not json".utf8))
        session.handle(line: json(["id": "x", "op": "teleport"]))
        session.handle(line: json(["op": "generate"]))
        session.handle(line: json(["op": "cancel"]))
        session.drain()
        let errors = events.all.filter { $0["type"] as? String == "error" }
        #expect(errors.count == 4 && errors.allSatisfy { $0["code"] as? String == "invalid_request" })
        #expect(events.last("x")?["code"] as? String == "invalid_request")
    }

    @Test func aBackendFailureFailsThatRequestOnlyAndItsErrorTextNeverLeaves() {
        struct Boom: Error, CustomStringConvertible { var description: String { "secret-123 /private/path" } }
        backend.failure = Boom()
        generate("1")
        session.drain()
        #expect(code("1") == "backend_unavailable")
        #expect(!String(decoding: json(events.last("1")!), as: UTF8.self).contains("secret-123"))
        backend.failure = nil
        generate("2")
        session.drain()
        #expect(events.types("2").last == "result")
    }

    @Test func progressIsClampedAndRequestsRunInArrivalOrder() {
        backend.steps = 3
        generate("a"); generate("b")
        session.drain()
        let order = events.all.compactMap { $0["type"] as? String == "result" ? $0["id"] as? String : nil }
        #expect(order == ["a", "b"])
        #expect(events.of("a").compactMap { $0["fraction"] as? Double }.allSatisfy { (0...1).contains($0) })
    }
}
