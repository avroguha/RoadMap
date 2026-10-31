package main

import (
	"bytes"
	"errors"
	"image"
	"image/draw"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	comdlg32 = syscall.NewLazyDLL("comdlg32.dll")

	procMessageBox          = user32.NewProc("MessageBoxW")
	procFindWindow          = user32.NewProc("FindWindowW")
	procShowWindow          = user32.NewProc("ShowWindow")
	procSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	procIsIconic            = user32.NewProc("IsIconic")
	procOpenClipboard       = user32.NewProc("OpenClipboard")
	procCloseClipboard      = user32.NewProc("CloseClipboard")
	procEmptyClipboard      = user32.NewProc("EmptyClipboard")
	procSetClipboardData    = user32.NewProc("SetClipboardData")
	procRegisterClipFormat  = user32.NewProc("RegisterClipboardFormatW")
	procCreateMutex         = kernel32.NewProc("CreateMutexW")
	procGlobalAlloc         = kernel32.NewProc("GlobalAlloc")
	procGlobalLock          = kernel32.NewProc("GlobalLock")
	procGlobalUnlock        = kernel32.NewProc("GlobalUnlock")
	procGlobalFree          = kernel32.NewProc("GlobalFree")
	procGetSaveFileName     = comdlg32.NewProc("GetSaveFileNameW")
	procGetOpenFileName     = comdlg32.NewProc("GetOpenFileNameW")
)

const (
	swRestore  = 9
	swMaximize = 3
	cfDIB      = 8
	gmemMove   = 0x0002

	// Resource id of the icon group written by rsrc (see build.ps1).
	iconResourceID = 2
)

func utf16(s string) *uint16 {
	p, _ := syscall.UTF16PtrFromString(s)
	return p
}

func fatal(msg string) {
	procMessageBox.Call(0, uintptr(unsafe.Pointer(utf16(msg))), uintptr(unsafe.Pointer(utf16(appName))), 0x10)
	panic(msg)
}

// acquireSingleInstance returns false when another copy already owns the
// workspace; that copy's window is brought to the front instead.
func acquireSingleInstance(_ string) bool {
	name := utf16("Local\\RoadMapStudio.SingleInstance")
	h, _, err := procCreateMutex.Call(0, 0, uintptr(unsafe.Pointer(name)))
	errno, _ := err.(syscall.Errno)
	// After a self-update the old copy may still be shutting down: wait for it.
	for i := 0; afterUpdate && errno == syscall.ERROR_ALREADY_EXISTS && i < 40; i++ {
		syscall.CloseHandle(syscall.Handle(h))
		time.Sleep(300 * time.Millisecond)
		h, _, err = procCreateMutex.Call(0, 0, uintptr(unsafe.Pointer(name)))
		errno, _ = err.(syscall.Errno)
	}
	if errno == syscall.ERROR_ALREADY_EXISTS {
		if hwnd, _, _ := procFindWindow.Call(0, uintptr(unsafe.Pointer(utf16(appName)))); hwnd != 0 {
			if iconic, _, _ := procIsIconic.Call(hwnd); iconic != 0 {
				procShowWindow.Call(hwnd, swRestore)
			}
			procSetForegroundWindow.Call(hwnd)
		}
		return false
	}
	return true
}

func dataDirCandidates() []string {
	var out []string
	if pd := os.Getenv("ProgramData"); pd != "" {
		out = append(out, filepath.Join(pd, appDirName))
	}
	if la := os.Getenv("LOCALAPPDATA"); la != "" {
		out = append(out, filepath.Join(la, appDirName))
	}
	return out
}

// The named mutex already covers single-instance on Windows.
func announceInstance(string, string) {}
func forgetInstance(string)           {}

func runWindow(url string, srv *server) (ok bool) {
	runtime.LockOSThread()
	defer func() {
		if r := recover(); r != nil {
			ok = false
		}
	}()
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		AutoFocus: true,
		DataPath:  webviewDataPath(),
		WindowOptions: webview2.WindowOptions{
			Title: appName, Width: 1440, Height: 900, IconId: iconResourceID, Center: true,
		},
	})
	if w == nil {
		return false
	}
	defer w.Destroy()
	hwnd := uintptr(w.Window())
	srv.owner = func() uintptr { return hwnd }
	procShowWindow.Call(hwnd, swMaximize)
	w.Navigate(url)
	w.Run()
	return true
}

// webviewDataPath keeps the browser profile per user; only the workspace is shared.
func webviewDataPath() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, appDirName, "webview")
}

func hiddenCommand(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd
}

// shareWithAllUsers lets every local user edit the shared workspace; a folder
// created under ProgramData is otherwise writable only by its creator.
func shareWithAllUsers(dir string) {
	hiddenCommand("icacls", dir, "/grant", "*S-1-5-32-545:(OI)(CI)M", "/T", "/Q").Run()
}

func openBrowser(url string) {
	hiddenCommand("rundll32", "url.dll,FileProtocolHandler", url).Start()
}

func openFolder(dir string) {
	exec.Command("explorer", dir).Start()
}

// ---- file dialogs -------------------------------------------------------

type openFileName struct {
	structSize    uint32
	owner         uintptr
	instance      uintptr
	filter        *uint16
	customFilter  *uint16
	maxCustFilter uint32
	filterIndex   uint32
	file          *uint16
	maxFile       uint32
	fileTitle     *uint16
	maxFileTitle  uint32
	initialDir    *uint16
	title         *uint16
	flags         uint32
	fileOffset    uint16
	fileExtension uint16
	defExt        *uint16
	custData      uintptr
	hook          uintptr
	templateName  *uint16
	reserved      unsafe.Pointer
	dwReserved    uint32
	flagsEx       uint32
}

const (
	ofnOverwritePrompt = 0x00000002
	ofnHideReadOnly    = 0x00000004
	ofnNoChangeDir     = 0x00000008
	ofnPathMustExist   = 0x00000800
	ofnFileMustExist   = 0x00001000
	ofnExplorer        = 0x00080000
)

// dialogFilter turns "PNG image|*.png|All files|*.*" into the double-NUL
// terminated list the common dialogs expect, and returns the first extension.
func dialogFilter(filter string) ([]uint16, string) {
	if filter == "" {
		filter = "All files|*.*"
	}
	parts := strings.Split(filter, "|")
	var buf []uint16
	for _, p := range parts {
		buf = append(buf, syscall.StringToUTF16(p)...)
	}
	buf = append(buf, 0)
	ext := ""
	if len(parts) > 1 {
		ext = strings.TrimPrefix(strings.Split(parts[1], ";")[0], "*.")
		if ext == "*" {
			ext = ""
		}
	}
	return buf, ext
}

func fileDialog(proc *syscall.LazyProc, owner uintptr, title, name, filter string, flags uint32) (string, bool) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	filterBuf, ext := dialogFilter(filter)
	fileBuf := make([]uint16, 4096)
	copy(fileBuf, syscall.StringToUTF16(name))
	ofn := openFileName{
		owner:   owner,
		filter:  &filterBuf[0],
		file:    &fileBuf[0],
		maxFile: uint32(len(fileBuf)),
		flags:   flags | ofnExplorer | ofnNoChangeDir | ofnHideReadOnly,
	}
	ofn.structSize = uint32(unsafe.Sizeof(ofn))
	if title != "" {
		ofn.title = utf16(title)
	}
	if ext != "" {
		ofn.defExt = utf16(ext)
	}
	ret, _, _ := proc.Call(uintptr(unsafe.Pointer(&ofn)))
	runtime.KeepAlive(filterBuf)
	if ret == 0 {
		return "", false
	}
	return syscall.UTF16ToString(fileBuf), true
}

func saveDialog(owner uintptr, title, name, filter string) (string, bool) {
	return fileDialog(procGetSaveFileName, owner, title, name, filter, ofnOverwritePrompt|ofnPathMustExist)
}

func openDialog(owner uintptr, title, filter string) (string, bool) {
	return fileDialog(procGetOpenFileName, owner, title, "", filter, ofnFileMustExist|ofnPathMustExist)
}

// ---- clipboard ----------------------------------------------------------

func globalCopy(data []byte) (uintptr, error) {
	h, _, _ := procGlobalAlloc.Call(gmemMove, uintptr(len(data)))
	if h == 0 {
		return 0, errors.New("GlobalAlloc failed")
	}
	p, _, _ := procGlobalLock.Call(h)
	if p == 0 {
		procGlobalFree.Call(h)
		return 0, errors.New("GlobalLock failed")
	}
	copy(unsafe.Slice((*byte)(unsafe.Pointer(p)), len(data)), data)
	procGlobalUnlock.Call(h)
	return h, nil
}

// copyPNGToClipboard places the image as both a DIB (for Office and Paint)
// and the registered "PNG" format (for apps that keep full fidelity).
func copyPNGToClipboard(pngData []byte) error {
	src, err := png.Decode(bytes.NewReader(pngData))
	if err != nil {
		return err
	}
	b := src.Bounds()
	rgba := image.NewRGBA(b)
	draw.Draw(rgba, b, image.White, image.Point{}, draw.Src)
	draw.Draw(rgba, b, src, b.Min, draw.Over)

	w, h := b.Dx(), b.Dy()
	dib := make([]byte, 40+w*h*4)
	put32 := func(off int, v uint32) {
		dib[off], dib[off+1], dib[off+2], dib[off+3] = byte(v), byte(v>>8), byte(v>>16), byte(v>>24)
	}
	put32(0, 40)
	put32(4, uint32(w))
	put32(8, uint32(h)) // positive height = bottom-up rows
	dib[12], dib[14] = 1, 32
	put32(20, uint32(w*h*4))
	for y := 0; y < h; y++ {
		row := rgba.Pix[(h-1-y)*rgba.Stride:]
		out := dib[40+y*w*4:]
		for x := 0; x < w; x++ {
			out[x*4], out[x*4+1], out[x*4+2], out[x*4+3] = row[x*4+2], row[x*4+1], row[x*4], 0xff
		}
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	opened := false
	for i := 0; i < 10 && !opened; i++ {
		if r, _, _ := procOpenClipboard.Call(0); r != 0 {
			opened = true
		} else {
			time.Sleep(30 * time.Millisecond)
		}
	}
	if !opened {
		return errors.New("the clipboard is in use by another program")
	}
	defer procCloseClipboard.Call()
	procEmptyClipboard.Call()

	hDib, err := globalCopy(dib)
	if err != nil {
		return err
	}
	if r, _, _ := procSetClipboardData.Call(cfDIB, hDib); r == 0 {
		procGlobalFree.Call(hDib)
		return errors.New("SetClipboardData failed")
	}
	if pngFormat, _, _ := procRegisterClipFormat.Call(uintptr(unsafe.Pointer(utf16("PNG")))); pngFormat != 0 {
		if hPng, err := globalCopy(pngData); err == nil {
			if r, _, _ := procSetClipboardData.Call(pngFormat, hPng); r == 0 {
				procGlobalFree.Call(hPng)
			}
		}
	}
	return nil
}
