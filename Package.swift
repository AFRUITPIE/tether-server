// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "TetherProtocol",
    platforms: [.macOS(.v15), .iOS(.v18)],
    products: [
        .library(name: "TetherProtocol", targets: ["TetherProtocol"]),
    ],
    targets: [
        .target(name: "TetherProtocol", path: "Sources/TetherProtocol"),
        .testTarget(
            name: "TetherProtocolTests",
            dependencies: ["TetherProtocol"],
            path: "Tests/TetherProtocolTests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
