import Foundation
import Testing
@testable import TetherProtocol

private func fixtureLines(_ name: String) throws -> [JSONValue] {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: "jsonl", subdirectory: "Fixtures"))
    let text = try String(contentsOf: url, encoding: .utf8)
    return try text.split(separator: "\n").map { try JSONDecoder().decode(JSONValue.self, from: Data($0.utf8)) }
}

@Test func everyRecordedMessageDecodesWithoutFallback() throws {
    let lines = try fixtureLines("e2e-wire")
    #expect(lines.count > 100)
    var kinds = Set<String>()
    func check(_ item: Item) {
        if case .unknown(let v) = item { Issue.record("unknown item \(v)") }
        kinds.insert(item.type)
    }
    for line in lines {
        let method = try #require(line["method"]?.stringValue)
        let params = try JSONEncoder().encode(line["params"] ?? .null)
        if line["kind"]?.stringValue == "request" {
            let req = try ServerRequest(method: method, params: params)
            if case .unknown = req { Issue.record("unknown server request \(method)") }
        } else {
            let n = try ServerNotification(method: method, params: params)
            switch n {
            case .unknown: Issue.record("unknown notification \(method)")
            case .threadRawEvent: break // intentionally untyped
            case .itemStarted(let e): check(e.item)
            case .itemCompleted(let e): check(e.item)
            case .itemUpdated(let e): check(e.item)
            default: break
            }
            #expect(n.threadId != nil)
            #expect(n.seq != nil)
        }
    }
    #expect(kinds.isSuperset(of: ["userMessage", "agentMessage", "reasoning", "toolCall"]))
}

@Test func roundTripsItemsAndResponses() throws {
    let lines = try fixtureLines("e2e-wire")
    for line in lines where line["method"]?.stringValue == "item/completed" {
        let data = try JSONEncoder().encode(line["params"]!)
        let decoded = try JSONDecoder().decode(ItemCompletedNotification.self, from: data)
        let again = try JSONDecoder().decode(ItemCompletedNotification.self, from: JSONEncoder().encode(decoded))
        #expect(decoded == again)
    }
    let allow = PermissionRequestResponse.allow(.init(scope: .session))
    let json = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(allow))
    #expect(json == ["decision": "allow", "scope": "session"])
}

@Test func requiredNullableEncodesNull() throws {
    let p = ThreadSetModelParams(threadId: "t", model: nil)
    let json = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(p))
    #expect(json["model"] == .null)
}

@Test func unknownEnumValuesAndVariantsSurvive() throws {
    let status = try JSONDecoder().decode(ThreadStatus.self, from: Data(#""hibernating""#.utf8))
    #expect(status.rawValue == "hibernating")
    let item = try JSONDecoder().decode(Item.self, from: Data(#"{"type":"hologram","id":"x"}"#.utf8))
    guard case .unknown = item else { Issue.record("expected unknown"); return }
    #expect(item.type == "hologram")
}
