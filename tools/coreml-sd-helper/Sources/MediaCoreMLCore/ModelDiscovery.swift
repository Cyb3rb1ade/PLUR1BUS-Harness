import Foundation

/// Finds compiled Core ML Stable Diffusion models below `root`. Understood layouts:
///   <root>/<name>/{TextEncoder,Unet|UnetChunk1,VAEDecoder}.mlmodelc          (Mochi-style folders)
///   <root>/<name>/{split_einsum,original}/compiled/...                         (Apple's published layout)
///   <root>/<name>/compiled/...
/// Symbolic links, hidden entries and incomplete folders are ignored. Nothing is read from inside a model.
public func discoverModels(in root: URL) -> [ModelEntry] {
    let fm = FileManager.default
    var found: [ModelEntry] = []
    func isRealDirectory(_ url: URL) -> Bool {
        guard let v = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]) else { return false }
        return v.isDirectory == true && v.isSymbolicLink != true
    }
    func exists(_ dir: URL, _ name: String) -> Bool { fm.fileExists(atPath: dir.appendingPathComponent(name).path) }
    func isCompiled(_ dir: URL) -> Bool {
        isRealDirectory(dir) && exists(dir, "TextEncoder.mlmodelc") && exists(dir, "VAEDecoder.mlmodelc") && (exists(dir, "Unet.mlmodelc") || exists(dir, "UnetChunk1.mlmodelc"))
    }
    func attention(_ text: String) -> Attention {
        let t = text.lowercased()
        if t.contains("split") { return .splitEinsum }
        if t.contains("original") { return .original }
        return .unknown
    }
    guard let children = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey], options: [.skipsHiddenFiles]) else { return [] }
    for child in children where isRealDirectory(child) {
        let name = child.lastPathComponent
        if isCompiled(child) { found.append(ModelEntry(name: name, resources: child, attention: attention(name))); continue }
        for (variant, kind) in [("split_einsum", Attention.splitEinsum), ("original", Attention.original)] {
            for candidate in [child.appendingPathComponent(variant).appendingPathComponent("compiled"), child.appendingPathComponent(variant)] where isCompiled(candidate) {
                found.append(ModelEntry(name: "\(name)/\(variant)", resources: candidate, attention: kind)); break
            }
        }
        let plain = child.appendingPathComponent("compiled")
        if isCompiled(plain) { found.append(ModelEntry(name: name, resources: plain, attention: attention(name))) }
    }
    return found.sorted { $0.name < $1.name }
}
