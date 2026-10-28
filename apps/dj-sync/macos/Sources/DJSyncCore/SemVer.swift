/// A semantic version (`1.0.0`, `1.0.0-rc.1`), ordered per semver.org:
/// a pre-release sorts before its release, and numeric identifiers compare
/// as numbers (`rc.10` > `rc.9`). Build metadata (`+…`) is ignored.
public struct SemVer: Comparable, Hashable, Sendable, CustomStringConvertible {
  public var major: Int
  public var minor: Int
  public var patch: Int
  public var prerelease: [String]

  public init?(_ string: String) {
    var s = Substring(string.trimmingCharacters(in: .whitespaces))
    if s.first == "v" { s = s.dropFirst() }
    if let plus = s.firstIndex(of: "+") { s = s[..<plus] }
    let parts = s.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
    let core = parts[0].split(separator: ".", omittingEmptySubsequences: false)
    guard core.count == 3, let major = Int(core[0]), let minor = Int(core[1]), let patch = Int(core[2])
    else { return nil }
    self.major = major
    self.minor = minor
    self.patch = patch
    if parts.count == 2 {
      let ids = parts[1].split(separator: ".", omittingEmptySubsequences: false).map(String.init)
      guard !ids.contains(where: \.isEmpty) else { return nil }
      prerelease = ids
    } else {
      prerelease = []
    }
  }

  public var description: String {
    "\(major).\(minor).\(patch)" + (prerelease.isEmpty ? "" : "-" + prerelease.joined(separator: "."))
  }

  public static func < (a: SemVer, b: SemVer) -> Bool {
    if (a.major, a.minor, a.patch) != (b.major, b.minor, b.patch) {
      return (a.major, a.minor, a.patch) < (b.major, b.minor, b.patch)
    }
    switch (a.prerelease.isEmpty, b.prerelease.isEmpty) {
    case (true, true), (true, false): return false
    case (false, true): return true
    case (false, false): break
    }
    for (x, y) in zip(a.prerelease, b.prerelease) where x != y {
      switch (Int(x), Int(y)) {
      case let (nx?, ny?): return nx < ny
      case (.some, nil): return true
      case (nil, .some): return false
      case (nil, nil): return x < y
      }
    }
    return a.prerelease.count < b.prerelease.count
  }
}
