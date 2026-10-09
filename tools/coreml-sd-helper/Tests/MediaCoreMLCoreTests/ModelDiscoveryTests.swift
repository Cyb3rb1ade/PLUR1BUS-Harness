import Testing
import Foundation
@testable import MediaCoreMLCore

@Suite struct ModelDiscoveryTests {
    @Test func findsMochiStyleAndAppleLayoutsAndInfersTheAttentionVariant() {
        let root = makeTree(
            complete("sd15_split-einsum_compiled") + complete("sd15_original_compiled") + complete("plain-model")
            + complete("apple-sd/split_einsum/compiled") + complete("apple-sd/original/compiled") + complete("wrapped/compiled")
            + ["chunked/TextEncoder.mlmodelc", "chunked/UnetChunk1.mlmodelc", "chunked/UnetChunk2.mlmodelc", "chunked/VAEDecoder.mlmodelc"])
        let found = discoverModels(in: root)
        #expect(found.map { $0.name } == ["apple-sd/original", "apple-sd/split_einsum", "chunked", "plain-model", "sd15_original_compiled", "sd15_split-einsum_compiled", "wrapped"])
        let by = Dictionary(uniqueKeysWithValues: found.map { ($0.name, $0.attention) })
        #expect(by["sd15_split-einsum_compiled"] == .splitEinsum)
        #expect(by["sd15_original_compiled"] == .original)
        #expect(by["apple-sd/split_einsum"] == .splitEinsum)
        #expect(by["apple-sd/original"] == .original)
        #expect(by["plain-model"] == .unknown)
    }

    @Test func attentionPicksTheComputeUnitsThatSuitIt() {
        #expect(Attention.splitEinsum.defaultComputeUnits == .cpuAndNeuralEngine)
        #expect(Attention.original.defaultComputeUnits == .cpuAndGPU)
        #expect(Attention.unknown.defaultComputeUnits == .all)
    }

    @Test func ignoresIncompleteFoldersHiddenEntriesFilesAndSymlinks() throws {
        let root = makeTree(
            ["no-unet/TextEncoder.mlmodelc", "no-unet/VAEDecoder.mlmodelc", "no-decoder/TextEncoder.mlmodelc", "no-decoder/Unet.mlmodelc"]
            + complete(".hidden") + complete("real"))
        try Data().write(to: root.appendingPathComponent("stray-file"))
        let outside = makeTree(complete("elsewhere"))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("linked"), withDestinationURL: outside.appendingPathComponent("elsewhere"))
        try FileManager.default.createSymbolicLink(atPath: root.appendingPathComponent("linked-parent").path, withDestinationPath: outside.path)
        #expect(discoverModels(in: root).map { $0.name } == ["real"])
    }

    @Test func missingOrEmptyDirectoriesYieldNoModels() {
        #expect(discoverModels(in: URL(fileURLWithPath: "/nonexistent/\(UUID().uuidString)")).isEmpty)
        #expect(discoverModels(in: makeTree([])).isEmpty)
    }
}
