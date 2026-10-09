import Foundation
import MediaCoreMLCore

/// Thread-safe sink for the session's output.
final class Events {
    private let lock = NSLock()
    private var items: [[String: Any]] = []
    func add(_ m: [String: Any]) { lock.lock(); items.append(m); lock.unlock() }
    var all: [[String: Any]] { lock.lock(); defer { lock.unlock() }; return items }
    func of(_ id: String) -> [[String: Any]] { all.filter { $0["id"] as? String == id } }
    func last(_ id: String) -> [String: Any]? { of(id).last }
    func types(_ id: String) -> [String] { of(id).compactMap { $0["type"] as? String } }
}

/// Stands in for the diffusion pipeline: no model, no Core ML.
final class FakeBackend: DiffusionBackend {
    private let lock = NSLock()
    private var recorded: [GenerationJob] = []
    var steps = 2
    var images: (GenerationJob) -> [Data?] = { job in (0..<job.imageCount).map { _ in Data([0x89, 0x50, 0x4e, 0x47]) } }
    /// When set, the job blocks after its first progress event until the gate is signalled.
    var gate: DispatchSemaphore?
    let started = DispatchSemaphore(value: 0)
    var failure: Error?
    var jobs: [GenerationJob] { lock.lock(); defer { lock.unlock() }; return recorded }
    func generate(_ job: GenerationJob, progress: (Double) -> Bool) throws -> [Data?] {
        lock.lock(); recorded.append(job); lock.unlock()
        started.signal()
        if let failure { throw failure }
        for step in 0..<steps {
            let keepGoing = progress(Double(step + 1) / Double(steps))
            if step == 0 { gate?.wait() }
            if !keepGoing { throw HelperError.cancelled }
        }
        return images(job)
    }
}

func json(_ object: [String: Any]) -> Data { try! JSONSerialization.data(withJSONObject: object) }

/// Creates empty `.mlmodelc` directories; discovery only looks at names.
func makeTree(_ paths: [String]) -> URL {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("media-coreml-tests-\(UUID().uuidString)")
    for path in paths { try! FileManager.default.createDirectory(at: root.appendingPathComponent(path), withIntermediateDirectories: true) }
    if paths.isEmpty { try! FileManager.default.createDirectory(at: root, withIntermediateDirectories: true) }
    return root
}
func complete(_ base: String, encoder: Bool = false) -> [String] {
    ["TextEncoder.mlmodelc", "Unet.mlmodelc", "VAEDecoder.mlmodelc"].map { "\(base)/\($0)" } + (encoder ? ["\(base)/VAEEncoder.mlmodelc"] : [])
}
