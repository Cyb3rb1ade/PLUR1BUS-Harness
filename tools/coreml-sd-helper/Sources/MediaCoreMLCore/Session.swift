import Foundation

/// JSON-Lines protocol `jsonl/1`. One request per line on stdin, events per line on stdout.
///   {"id","op":"generate|img2img","model","modelsDir","outputDir","computeUnits"?,"inputPath"?,"request":{prompt,negativePrompt?,n?,seed?,steps?,guidance?,scheduler?,strength?}}
///   {"id","op":"list-models","modelsDir"}      {"op":"cancel","target":"<id>"}
///   -> {"id","type":"progress","fraction"} {"id","type":"result","files":["0.png"],"seed"} {"id","type":"models","models":[...]} {"id","type":"error","code"}
/// Requests run one at a time in arrival order. A cancel stops the running job at the next step or drops a queued one.
public final class JSONLSession {
    struct Params: Decodable {
        let prompt: String; let negativePrompt: String?; let n: Int?; let seed: UInt32?; let steps: Int?; let guidance: Float?; let scheduler: String?; let strength: Float?
    }
    struct Wire: Decodable {
        let id: String?; let op: String; let target: String?; let model: String?; let modelsDir: String?; let outputDir: String?; let computeUnits: String?; let inputPath: String?; let request: Params?
    }
    private let backend: DiffusionBackend
    private let defaultModelsDir: URL
    private let randomSeed: () -> UInt32
    private let emitMessage: ([String: Any]) -> Void
    private let queue = DispatchQueue(label: "media-coreml.session")
    private let group = DispatchGroup()
    private let lock = NSLock()
    private var live = Set<String>()
    private var cancelled = Set<String>()

    public init(backend: DiffusionBackend, defaultModelsDir: URL, randomSeed: @escaping () -> UInt32 = { UInt32.random(in: 0...UInt32.max) }, emit: @escaping ([String: Any]) -> Void) {
        self.backend = backend; self.defaultModelsDir = defaultModelsDir; self.randomSeed = randomSeed; self.emitMessage = emit
    }

    /// Never blocks on a running job, so a cancel can overtake it.
    public func handle(line: Data) {
        guard let wire = try? JSONDecoder().decode(Wire.self, from: line) else {
            // Keep the id when the line is JSON but a field is out of range, so the caller can tell which request failed.
            var message: [String: Any] = ["type": "error", "code": HelperError.invalidRequest.code]
            if let loose = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any], let id = loose["id"] as? String { message["id"] = id }
            emitMessage(message); return
        }
        switch wire.op {
        case "cancel":
            guard let target = wire.target else { emitMessage(["type": "error", "code": HelperError.invalidRequest.code]); return }
            lock.lock(); if live.contains(target) { cancelled.insert(target) }; lock.unlock()
        case "generate", "img2img", "list-models":
            guard let id = wire.id, !id.isEmpty else { emitMessage(["type": "error", "code": HelperError.invalidRequest.code]); return }
            lock.lock(); live.insert(id); lock.unlock()
            group.enter()
            queue.async { [self] in
                defer { lock.lock(); live.remove(id); cancelled.remove(id); lock.unlock(); group.leave() }
                do { try run(id: id, wire: wire) }
                catch let e as HelperError { emitMessage(["id": id, "type": "error", "code": e.code]) }
                catch { emitMessage(["id": id, "type": "error", "code": HelperError.backend.code]) }
            }
        default:
            var message: [String: Any] = ["type": "error", "code": HelperError.invalidRequest.code]
            if let id = wire.id { message["id"] = id }
            emitMessage(message)
        }
    }

    /// Waits until every accepted request has produced its terminal message.
    public func drain() { group.wait() }

    private func isCancelled(_ id: String) -> Bool { lock.lock(); defer { lock.unlock() }; return cancelled.contains(id) }

    private func modelsRoot(_ wire: Wire) -> URL {
        guard let dir = wire.modelsDir, !dir.isEmpty else { return defaultModelsDir }
        return URL(fileURLWithPath: NSString(string: dir).expandingTildeInPath).resolvingSymlinksInPath()
    }

    private func run(id: String, wire: Wire) throws {
        if isCancelled(id) { throw HelperError.cancelled }
        let models = discoverModels(in: modelsRoot(wire))
        if wire.op == "list-models" { emitMessage(["id": id, "type": "models", "models": models.map { $0.name }]); return }
        guard let params = wire.request, !params.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let name = wire.model, let outputDir = wire.outputDir, outputDir.hasPrefix("/") else { throw HelperError.invalidRequest }
        let n = params.n ?? 1, steps = params.steps ?? 30
        guard (1...10).contains(n), (1...1000).contains(steps), params.guidance?.isFinite ?? true else { throw HelperError.invalidRequest }
        guard let model = models.first(where: { $0.name == name }) else { throw HelperError.modelNotFound }
        var units = model.attention.defaultComputeUnits
        if let raw = wire.computeUnits { guard let chosen = ComputeUnitsChoice(rawValue: raw) else { throw HelperError.invalidRequest }; units = chosen }
        var starting: Data? = nil; var strength: Float? = nil
        if wire.op == "img2img" {
            guard let path = wire.inputPath, path.hasPrefix("/"), FileManager.default.fileExists(atPath: model.resources.appendingPathComponent("VAEEncoder.mlmodelc").path) else { throw HelperError.invalidRequest }
            let url = URL(fileURLWithPath: path)
            guard let v = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]), v.isRegularFile == true, v.isSymbolicLink != true, (v.fileSize ?? Int.max) <= 64 * 1024 * 1024,
                  let data = try? Data(contentsOf: url) else { throw HelperError.invalidRequest }
            let s = params.strength ?? 0.75
            guard s > 0, s <= 1 else { throw HelperError.invalidRequest }
            starting = data; strength = s
        } else if params.strength != nil { throw HelperError.invalidRequest }
        let seed = params.seed ?? randomSeed()
        let job = GenerationJob(model: model, computeUnits: units, prompt: params.prompt, negativePrompt: params.negativePrompt ?? "", imageCount: n, seed: seed, steps: steps, guidance: params.guidance ?? 7.5, scheduler: params.scheduler, startingImage: starting, strength: strength)
        let images = try backend.generate(job) { fraction in
            emitMessage(["id": id, "type": "progress", "fraction": min(max(fraction, 0), 1)])
            return !isCancelled(id)
        }
        if isCancelled(id) { throw HelperError.cancelled }
        // A refused image means the safety checker fired. Never hand back the others to get around that decision.
        guard images.count == n, images.allSatisfy({ $0 != nil }) else { throw HelperError.contentPolicy }
        let out = URL(fileURLWithPath: outputDir)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var files: [String] = []
        for (index, image) in images.enumerated() {
            let file = "\(index).png"; let url = out.appendingPathComponent(file)
            try image!.write(to: url, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            files.append(file)
        }
        emitMessage(["id": id, "type": "result", "files": files, "seed": Int(seed)])
    }
}
