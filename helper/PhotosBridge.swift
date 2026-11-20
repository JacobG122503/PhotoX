// PhotoX Photos bridge
//
// A small background app (no Dock icon) that reads the Apple Photos library through PhotoKit, the
// official API, and serves it to the PhotoX dev server over 127.0.0.1. macOS asks once for
// permission ("PhotoX Photos" would like to access your photos). Photos stored only in iCloud are
// fetched by PhotoKit on demand. The library is never modified.
//
// Every request must carry the random token written to
// ~/Library/Application Support/PhotoX/bridge.json, which only the local Vite server reads, so other
// web pages can't use the bridge to read your library.
//
// Endpoints (GET):
//   /status                -> {"auth": "...", "version": N}
//   /authorize             -> shows the macOS permission prompt if needed, then the same as /status
//   /locations             -> {total, missing, assets: [[id, lat, lon, dateMs, isVideo, isFavorite, w, h, seconds]]}
//   /thumb?id=ID&s=PX      -> JPEG, about PX on the short side (square-ish crop is done by the page)
//   /image?id=ID&max=PX    -> JPEG, longest side <= PX (0 = full resolution), edits applied
//   /video?id=ID           -> the video file, with HTTP Range support so the browser can seek
//   /place?lat=..&lon=..   -> {title, subtitle} from Apple's reverse geocoder

import AppKit
import CoreLocation
import Foundation
import ImageIO
import Network
import Photos
import UniformTypeIdentifiers

let VERSION = 1
let IDLE_EXIT_SECONDS: TimeInterval = 30 * 60
let APP_FOLDER = "PhotoX"
let VIDEO_CHUNK = 8 * 1024 * 1024

// MARK: - helpers

func authString(_ s: PHAuthorizationStatus) -> String {
  switch s {
  case .authorized: return "authorized"
  case .limited: return "limited"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  @unknown default: return "unknown"
  }
}

func currentAuth() -> PHAuthorizationStatus { PHPhotoLibrary.authorizationStatus(for: .readWrite) }
func canRead() -> Bool { let a = currentAuth(); return a == .authorized || a == .limited }

func json(_ obj: Any) -> Data { (try? JSONSerialization.data(withJSONObject: obj, options: [])) ?? Data("null".utf8) }

func round6(_ x: Double) -> Double { (x * 1_000_000).rounded() / 1_000_000 }

// MARK: - locations

/// Every photo and video that has a location, oldest first. PHAsset.location is stored locally even
/// for iCloud-only items, so this never touches the network.
func listLocations() -> [String: Any] {
  let o = PHFetchOptions()
  o.predicate = NSPredicate(format: "mediaType == %d OR mediaType == %d", PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
  o.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
  o.includeHiddenAssets = false
  let r = PHAsset.fetchAssets(with: o)
  var rows: [[Any]] = []
  rows.reserveCapacity(r.count)
  var missing = 0
  r.enumerateObjects { a, _, _ in
    guard let c = a.location?.coordinate, CLLocationCoordinate2DIsValid(c), !(c.latitude == 0 && c.longitude == 0) else {
      missing += 1
      return
    }
    let date = (a.creationDate ?? a.modificationDate ?? Date(timeIntervalSince1970: 0)).timeIntervalSince1970 * 1000
    rows.append([
      a.localIdentifier, round6(c.latitude), round6(c.longitude), Int64(date),
      a.mediaType == .video ? 1 : 0, a.isFavorite ? 1 : 0, a.pixelWidth, a.pixelHeight, Int(a.duration.rounded()),
    ])
  }
  return ["version": VERSION, "total": r.count, "missing": missing, "assets": rows]
}

// MARK: - images

let encodeQueue = DispatchQueue(label: "encode", qos: .userInitiated, attributes: .concurrent)

func jpeg(_ cg: CGImage, quality: Double) -> Data? {
  let data = NSMutableData()
  guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
  CGImageDestinationAddImage(dest, cg, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
  return CGImageDestinationFinalize(dest) ? data as Data : nil
}

/// PhotoKit's fast resize mode can hand back a much bigger image than asked for. Shrink it so
/// thumbnails stay small on the wire.
func downscale(_ cg: CGImage, maxSide: Int) -> CGImage {
  let w = cg.width, h = cg.height, longest = max(w, h)
  guard maxSide > 0, longest > maxSide, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return cg }
  let k = Double(maxSide) / Double(longest)
  let nw = max(1, Int((Double(w) * k).rounded())), nh = max(1, Int((Double(h) * k).rounded()))
  guard let ctx = CGContext(data: nil, width: nw, height: nh, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return cg }
  ctx.interpolationQuality = .high
  ctx.draw(cg, in: CGRect(x: 0, y: 0, width: nw, height: nh))
  return ctx.makeImage() ?? cg
}

enum Fit { case thumb(Int), maxSide(Int) }

func requestJPEG(id: String, fit: Fit, done: @escaping (Data?, String?) -> Void) {
  guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else { return done(nil, "photo not found") }
  let o = PHImageRequestOptions()
  o.deliveryMode = .highQualityFormat // one callback, never a blurry placeholder
  o.isNetworkAccessAllowed = true // iCloud-only photos are downloaded behind the scenes
  o.isSynchronous = false
  o.version = .current // include the user's edits and crops
  let size: CGSize
  let mode: PHImageContentMode
  let quality: Double
  var shrinkTo = 0
  switch fit {
  case .thumb(let s):
    o.resizeMode = .fast
    size = CGSize(width: s, height: s)
    mode = .aspectFill
    quality = 0.8
    shrinkTo = s * 2
  case .maxSide(let m):
    o.resizeMode = .exact
    let longest = max(asset.pixelWidth, asset.pixelHeight)
    if m <= 0 || longest == 0 || m >= longest {
      size = PHImageManagerMaximumSize
    } else {
      let k = Double(m) / Double(longest)
      size = CGSize(width: (Double(asset.pixelWidth) * k).rounded(), height: (Double(asset.pixelHeight) * k).rounded())
    }
    mode = .aspectFit
    quality = m > 0 && m <= 1600 ? 0.86 : 0.92
  }
  PHImageManager.default().requestImage(for: asset, targetSize: size, contentMode: mode, options: o) { img, info in
    if let err = info?[PHImageErrorKey] as? Error { return done(nil, err.localizedDescription) }
    if (info?[PHImageCancelledKey] as? Bool) == true { return done(nil, "cancelled") }
    guard let img else { return done(nil, "Photos returned no image") }
    encodeQueue.async {
      var rect = CGRect(origin: .zero, size: img.size)
      guard var cg = img.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return done(nil, "could not read image") }
      if shrinkTo > 0 { cg = downscale(cg, maxSide: shrinkTo) }
      done(jpeg(cg, quality: quality), nil)
    }
  }
}

// MARK: - videos
//
// Browsers need to seek inside a video with Range requests, so the video is copied (downloaded from
// iCloud if needed) into ~/Library/Caches/PhotoX/videos once and served from there. Copies unused for
// two weeks are deleted when the helper starts.

let videoDir: URL = {
  let d = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    .appendingPathComponent(APP_FOLDER).appendingPathComponent("videos")
  try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
  return d
}()

var videoWaiters: [String: [(URL?, String?) -> Void]] = [:] // main queue only

func videoFile(id: String, done: @escaping (URL?, String?) -> Void) {
  guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else { return done(nil, "video not found") }
  guard asset.mediaType == .video else { return done(nil, "not a video") }
  let resources = PHAssetResource.assetResources(for: asset)
  guard let res = resources.first(where: { $0.type == .fullSizeVideo }) ?? resources.first(where: { $0.type == .video }) else {
    return done(nil, "Photos has no video data for this item")
  }
  var ext = (res.originalFilename as NSString).pathExtension.lowercased()
  if ext.isEmpty { ext = "mov" }
  let stamp = Int((asset.modificationDate ?? Date(timeIntervalSince1970: 0)).timeIntervalSince1970)
  let safe = id.map { $0.isLetter || $0.isNumber ? String($0) : "_" }.joined()
  let key = "\(safe)-\(res.type.rawValue)-\(stamp)"
  let dest = videoDir.appendingPathComponent("\(key).\(ext)")
  if FileManager.default.fileExists(atPath: dest.path) {
    try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: dest.path)
    return done(dest, nil)
  }
  if videoWaiters[key] != nil { videoWaiters[key]!.append(done); return }
  videoWaiters[key] = [done]
  let tmp = videoDir.appendingPathComponent("\(key).\(UUID().uuidString).part")
  let o = PHAssetResourceRequestOptions()
  o.isNetworkAccessAllowed = true
  PHAssetResourceManager.default().writeData(for: res, toFile: tmp, options: o) { err in
    DispatchQueue.main.async {
      var url: URL?
      var msg: String?
      if let err {
        msg = err.localizedDescription
        try? FileManager.default.removeItem(at: tmp)
      } else {
        try? FileManager.default.removeItem(at: dest)
        do { try FileManager.default.moveItem(at: tmp, to: dest); url = dest } catch { msg = error.localizedDescription }
      }
      for w in videoWaiters.removeValue(forKey: key) ?? [] { w(url, msg) }
    }
  }
}

func pruneVideoCache() {
  let fm = FileManager.default
  let cutoff = Date().addingTimeInterval(-14 * 24 * 3600)
  let files = (try? fm.contentsOfDirectory(at: videoDir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
  for f in files {
    let mod = (try? f.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
    if f.pathExtension == "part" || mod < cutoff { try? fm.removeItem(at: f) }
  }
}

/// Parses a single "bytes=a-b" range. Returns nil when there is no usable Range header.
func parseRange(_ header: String?, size: Int) -> (Int, Int)?? {
  guard let header, header.hasPrefix("bytes="), size > 0 else { return .some(nil) }
  let spec = header.dropFirst(6).split(separator: ",").first.map(String.init) ?? ""
  let parts = spec.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
  guard parts.count == 2 else { return .some(nil) }
  var start: Int, end: Int
  if parts[0].isEmpty {
    guard let n = Int(parts[1]), n > 0 else { return nil }
    start = max(0, size - n); end = size - 1
  } else {
    guard let s = Int(parts[0]) else { return .some(nil) }
    start = s
    end = parts[1].isEmpty ? size - 1 : min(Int(parts[1]) ?? (size - 1), size - 1)
  }
  guard start < size, start <= end else { return nil } // unsatisfiable
  return .some((start, end))
}

// MARK: - place names

func placeInfo(_ p: CLPlacemark) -> [String: Any] {
  let city = p.locality ?? p.subAdministrativeArea
  let title = p.areasOfInterest?.first ?? p.inlandWater ?? p.ocean ?? p.subLocality ?? city ?? p.name ?? p.country ?? "Unknown place"
  var seen = Set([title])
  var sub: [String] = []
  for part in [city, p.administrativeArea, p.country] {
    if let part, !part.isEmpty, !seen.contains(part) { sub.append(part); seen.insert(part) }
  }
  return ["title": title, "subtitle": sub.joined(separator: ", ")]
}

/// Apple's geocoder handles one request at a time and rate-limits bursts, so requests are queued and
/// the results cached. The page only asks for the photo you are looking at.
final class Places {
  let geocoder = CLGeocoder()
  var cache: [String: [String: Any]] = [:]
  var queue: [(key: String, loc: CLLocation, done: ([String: Any]) -> Void)] = []
  var busy = false

  func lookup(lat: Double, lon: Double, done: @escaping ([String: Any]) -> Void) {
    let key = String(format: "%.3f,%.3f", lat, lon)
    if let c = cache[key] { return done(c) }
    queue.append((key, CLLocation(latitude: lat, longitude: lon), done))
    while queue.count > 4 { queue.removeFirst().done(["error": "skipped"]) } // the user moved on
    pump()
  }

  func pump() {
    guard !busy, !queue.isEmpty else { return }
    let next = queue.removeFirst()
    if let c = cache[next.key] { next.done(c); return pump() }
    busy = true
    geocoder.reverseGeocodeLocation(next.loc) { marks, err in
      DispatchQueue.main.async {
        self.busy = false
        if let p = marks?.first {
          let info = placeInfo(p)
          self.cache[next.key] = info
          next.done(info)
        } else {
          next.done(["error": err?.localizedDescription ?? "no place found"])
        }
        self.pump()
      }
    }
  }
}

let places = Places()

// MARK: - minimal HTTP server

struct Request { let path: String; let query: [String: String]; let headers: [String: String] }

func parse(_ data: Data) -> Request? {
  guard let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) else { return nil }
  let lines = text.components(separatedBy: "\r\n")
  let parts = lines.first?.split(separator: " ") ?? []
  guard parts.count >= 2 else { return nil }
  var headers: [String: String] = [:]
  for l in lines.dropFirst() {
    guard let i = l.firstIndex(of: ":") else { continue }
    headers[l[..<i].lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)
  }
  let comps = URLComponents(string: String(parts[1]))
  var q: [String: String] = [:]
  for item in comps?.queryItems ?? [] { q[item.name] = item.value ?? "" }
  return Request(path: comps?.path ?? "/", query: q, headers: headers)
}

final class Server {
  let token: String
  let listener: NWListener
  var lastActivity = Date()

  init() throws {
    var bytes = [UInt8](repeating: 0, count: 24)
    _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    token = bytes.map { String(format: "%02x", $0) }.joined()
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
    params.allowLocalEndpointReuse = true
    listener = try NWListener(using: params)
  }

  func start() {
    listener.newConnectionHandler = { [weak self] c in self?.accept(c) }
    listener.stateUpdateHandler = { [weak self] st in
      guard let self else { return }
      switch st {
      case .ready: self.writeInfo()
      case .failed(let e): FileHandle.standardError.write(Data("listener failed: \(e)\n".utf8)); exit(1)
      default: break
      }
    }
    listener.start(queue: .main)
    Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
      if let self, Date().timeIntervalSince(self.lastActivity) > IDLE_EXIT_SECONDS { self.removeInfo(); exit(0) }
    }
  }

  static var infoURL: URL {
    let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent(APP_FOLDER)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("bridge.json")
  }

  func writeInfo() {
    guard let port = listener.port?.rawValue else { return }
    let info = json(["port": Int(port), "token": token, "pid": Int(getpid()), "version": VERSION])
    try? info.write(to: Server.infoURL, options: [.atomic])
    chmod(Server.infoURL.path, 0o600)
  }

  func removeInfo() { try? FileManager.default.removeItem(at: Server.infoURL) }

  func accept(_ c: NWConnection) {
    c.start(queue: .main)
    receive(c, Data())
  }

  func receive(_ c: NWConnection, _ buf: Data) {
    c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, err in
      guard let self else { return }
      var b = buf
      if let data { b.append(data) }
      if b.range(of: Data("\r\n\r\n".utf8)) != nil {
        self.handle(c, b)
      } else if complete || err != nil || b.count > 65536 {
        c.cancel()
      } else {
        self.receive(c, b)
      }
    }
  }

  func send(_ c: NWConnection, _ status: Int, _ type: String, _ body: Data, headers: [String: String] = [:], cache: String = "no-store") {
    let reasons = [200: "OK", 206: "Partial Content", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
                   404: "Not Found", 416: "Range Not Satisfiable", 500: "Error", 502: "Bad Gateway"]
    var head = "HTTP/1.1 \(status) \(reasons[status] ?? "OK")\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nCache-Control: \(cache)\r\nConnection: close\r\n"
    for (k, v) in headers { head += "\(k): \(v)\r\n" }
    head += "\r\n"
    var out = Data(head.utf8)
    out.append(body)
    c.send(content: out, completion: .contentProcessed { _ in c.cancel() })
  }

  func sendJSON(_ c: NWConnection, _ obj: Any, status: Int = 200) { send(c, status, "application/json", json(obj)) }
  func fail(_ c: NWConnection, _ status: Int, _ msg: String) { sendJSON(c, ["error": msg], status: status) }

  func sendImage(_ c: NWConnection, _ id: String, _ fit: Fit) {
    requestJPEG(id: id, fit: fit) { data, err in
      DispatchQueue.main.async {
        self.lastActivity = Date()
        if let data { self.send(c, 200, "image/jpeg", data, cache: "private, max-age=86400") } else { self.fail(c, 500, err ?? "failed") }
      }
    }
  }

  func sendVideo(_ c: NWConnection, _ url: URL, range: String?) {
    guard let data = try? Data(contentsOf: url, options: .alwaysMapped) else { return fail(c, 500, "could not read video") }
    let size = data.count
    // Chrome and Safari both accept .mov (QuickTime) bytes labelled as MP4.
    let type = "video/mp4"
    let cache = "private, max-age=86400"
    guard let parsed = parseRange(range, size: size) else {
      return send(c, 416, "text/plain", Data(), headers: ["Content-Range": "bytes */\(size)"])
    }
    if let r = parsed {
      let start = r.0, end = min(r.1, r.0 + VIDEO_CHUNK - 1)
      send(c, 206, type, data.subdata(in: start..<(end + 1)),
           headers: ["Content-Range": "bytes \(start)-\(end)/\(size)", "Accept-Ranges": "bytes"], cache: cache)
    } else {
      send(c, 200, type, data, headers: ["Accept-Ranges": "bytes"], cache: cache)
    }
  }

  func handle(_ c: NWConnection, _ data: Data) {
    lastActivity = Date()
    guard let req = parse(data) else { return fail(c, 400, "bad request") }
    guard req.headers["x-photox-token"] == token else { return fail(c, 401, "bad token") }
    switch req.path {
    case "/status":
      sendJSON(c, ["auth": authString(currentAuth()), "version": VERSION])
    case "/authorize":
      if currentAuth() != .notDetermined { return sendJSON(c, ["auth": authString(currentAuth()), "version": VERSION]) }
      NSApp.activate(ignoringOtherApps: true)
      PHPhotoLibrary.requestAuthorization(for: .readWrite) { s in
        DispatchQueue.main.async { self.sendJSON(c, ["auth": authString(s), "version": VERSION]) }
      }
    case "/locations":
      guard canRead() else { return fail(c, 403, "no Photos permission") }
      DispatchQueue.global(qos: .userInitiated).async {
        let body = json(listLocations())
        DispatchQueue.main.async { self.send(c, 200, "application/json", body) }
      }
    case "/thumb":
      guard canRead() else { return fail(c, 403, "no Photos permission") }
      guard let id = req.query["id"], !id.isEmpty else { return fail(c, 400, "missing id") }
      let s = min(1024, max(32, Int(req.query["s"] ?? "256") ?? 256))
      sendImage(c, id, .thumb(s))
    case "/image":
      guard canRead() else { return fail(c, 403, "no Photos permission") }
      guard let id = req.query["id"], !id.isEmpty else { return fail(c, 400, "missing id") }
      let m = min(8192, max(0, Int(req.query["max"] ?? "0") ?? 0))
      sendImage(c, id, .maxSide(m))
    case "/video":
      guard canRead() else { return fail(c, 403, "no Photos permission") }
      guard let id = req.query["id"], !id.isEmpty else { return fail(c, 400, "missing id") }
      let range = req.headers["range"]
      videoFile(id: id) { url, err in
        self.lastActivity = Date()
        guard let url else { return self.fail(c, 500, err ?? "failed") }
        self.sendVideo(c, url, range: range)
      }
    case "/place":
      guard let lat = Double(req.query["lat"] ?? ""), let lon = Double(req.query["lon"] ?? "") else { return fail(c, 400, "missing lat/lon") }
      places.lookup(lat: lat, lon: lon) { info in self.sendJSON(c, info) }
    default:
      fail(c, 404, "not found")
    }
  }
}

// MARK: - main

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // no Dock icon, no menu bar
let server: Server
do { server = try Server() } catch {
  FileHandle.standardError.write(Data("could not start: \(error)\n".utf8))
  exit(1)
}
server.start()
DispatchQueue.global(qos: .utility).async { pruneVideoCache() }
signal(SIGTERM) { _ in try? FileManager.default.removeItem(at: Server.infoURL); exit(0) }
app.run()
