import XCTest
import SwiftTreeSitter
import TreeSitterKernellog

final class TreeSitterKernellogTests: XCTestCase {
    func testCanLoadGrammar() throws {
        let parser = Parser()
        let language = Language(language: tree_sitter_kernellog())
        XCTAssertNoThrow(try parser.setLanguage(language),
                         "Error loading parse android kernel log and transform grammar")
    }
}
