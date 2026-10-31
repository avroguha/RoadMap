// mkmacapp packages the two macOS builds into "RoadMap Studio.app" inside a zip.
//
// It runs on any OS: the universal (fat) Mach-O header is written by hand, so
// Apple's lipo is not needed, and the zip records Unix permissions, which a zip
// made with Windows tools would lose (the app would then refuse to start).
//
//	mkmacapp <amd64 binary> <arm64 binary> <icns> <version> <output zip>
package main

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"fmt"
	"os"
	"time"
)

const (
	fatMagic      = 0xcafebabe
	cpuX8664      = 0x01000007
	cpuArm64      = 0x0100000c
	cpuSubX8664   = 3
	cpuSubArm64   = 0
	sliceAlignLog = 14 // 16 KiB, what lipo uses for both architectures
)

func universal(amd64, arm64 []byte) []byte {
	type slice struct {
		cpu, sub uint32
		data     []byte
	}
	slices := []slice{{cpuX8664, cpuSubX8664, amd64}, {cpuArm64, cpuSubArm64, arm64}}
	align := func(n int) int { a := 1 << sliceAlignLog; return (n + a - 1) / a * a }

	var out bytes.Buffer
	binary.Write(&out, binary.BigEndian, []uint32{fatMagic, uint32(len(slices))})
	offset := align(8 + 20*len(slices))
	offsets := make([]int, len(slices))
	for i, s := range slices {
		offsets[i] = offset
		binary.Write(&out, binary.BigEndian, []uint32{s.cpu, s.sub, uint32(offset), uint32(len(s.data)), sliceAlignLog})
		offset = align(offset + len(s.data))
	}
	for i, s := range slices {
		out.Write(make([]byte, offsets[i]-out.Len()))
		out.Write(s.data)
	}
	return out.Bytes()
}

func plist(version string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>RoadMap Studio</string>
	<key>CFBundleDisplayName</key><string>RoadMap Studio</string>
	<key>CFBundleIdentifier</key><string>studio.roadmap.app</string>
	<key>CFBundleExecutable</key><string>RoadMapStudio</string>
	<key>CFBundleIconFile</key><string>app</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>` + version + `</string>
	<key>CFBundleVersion</key><string>` + version + `</string>
	<key>LSMinimumSystemVersion</key><string>11.0</string>
	<key>LSUIElement</key><true/>
	<key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`
}

const readme = `RoadMap Studio for macOS
========================

1. Unzip, then drag "RoadMap Studio.app" into Applications (or anywhere).

2. First start only - the app is not signed with an Apple developer certificate,
   so macOS blocks it until you allow it once. Either:

   a) Terminal (quickest):
        xattr -dr com.apple.quarantine "/Applications/RoadMap Studio.app"

   b) or double-click the app, dismiss the warning, then open
      System Settings > Privacy & Security and press "Open Anyway".

3. Double-click the app. RoadMap Studio opens in its own window if Google Chrome
   or Microsoft Edge is installed, otherwise in your default browser.
   There is no Dock icon: the engine runs quietly in the background, stops by
   itself a few minutes after you close the page, and can be stopped at once from
   the (i) dialog > "Quit RoadMap Studio". Opening the app again returns you to
   the running page.

Your data: ~/Library/Application Support/RoadMapStudio
   workspace.json + history/ - the same files as the Windows version, so
   "Import / Export > Full backup" moves everything between a Mac and a PC.
`

func main() {
	if len(os.Args) != 6 {
		fmt.Fprintln(os.Stderr, "usage: mkmacapp <amd64> <arm64> <icns> <version> <out.zip>")
		os.Exit(2)
	}
	read := func(p string) []byte {
		b, err := os.ReadFile(p)
		if err != nil {
			panic(err)
		}
		return b
	}
	amd64, arm64, icns, version, outPath := read(os.Args[1]), read(os.Args[2]), read(os.Args[3]), os.Args[4], os.Args[5]

	out, err := os.Create(outPath)
	if err != nil {
		panic(err)
	}
	defer out.Close()
	zw := zip.NewWriter(out)
	add := func(name string, mode os.FileMode, data []byte) {
		h := &zip.FileHeader{Name: name, Method: zip.Deflate, Modified: time.Now()}
		h.SetMode(mode)
		w, err := zw.CreateHeader(h)
		if err != nil {
			panic(err)
		}
		if _, err := w.Write(data); err != nil {
			panic(err)
		}
	}
	const app = "RoadMap Studio.app/Contents/"
	for _, dir := range []string{"RoadMap Studio.app/", app, app + "MacOS/", app + "Resources/"} {
		add(dir, os.ModeDir|0o755, nil)
	}
	add(app+"Info.plist", 0o644, []byte(plist(version)))
	add(app+"PkgInfo", 0o644, []byte("APPL????"))
	add(app+"MacOS/RoadMapStudio", 0o755, universal(amd64, arm64))
	add(app+"Resources/app.icns", 0o644, icns)
	add("READ ME FIRST.txt", 0o644, []byte(readme))
	if err := zw.Close(); err != nil {
		panic(err)
	}
}
