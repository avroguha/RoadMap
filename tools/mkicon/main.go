// mkicon draws the application icon and writes build/app.ico (Windows) and build/app.icns (macOS).
package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"os"
)

type shape struct {
	x, y, w, h, r float64
	c             color.NRGBA
	diamond       bool
}

func inside(s shape, px, py float64) bool {
	if s.diamond {
		cx, cy := s.x+s.w/2, s.y+s.h/2
		dx, dy := px-cx, py-cy
		if dx < 0 {
			dx = -dx
		}
		if dy < 0 {
			dy = -dy
		}
		return dx/(s.w/2)+dy/(s.h/2) <= 1
	}
	if px < s.x || py < s.y || px > s.x+s.w || py > s.y+s.h {
		return false
	}
	cx := min(max(px, s.x+s.r), s.x+s.w-s.r)
	cy := min(max(py, s.y+s.r), s.y+s.h-s.r)
	return (px-cx)*(px-cx)+(py-cy)*(py-cy) <= s.r*s.r
}

func render(size int) []byte {
	white := func(a uint8) color.NRGBA { return color.NRGBA{255, 255, 255, a} }
	shapes := []shape{
		{0, 0, 32, 32, 8, color.NRGBA{0x4f, 0x6b, 0xed, 255}, false},
		{6, 8, 13, 4, 2, white(255), false},
		{11, 14, 15, 4, 2, white(205), false},
		{8, 20, 9, 4, 2, white(155), false},
		{20, 19, 6, 6, 0, white(255), true},
	}
	ss := 4
	if size >= 512 {
		ss = 2
	}
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	k := 32 / float64(size)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var r, g, b, a float64
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					px, py := (float64(x)+(float64(sx)+.5)/float64(ss))*k, (float64(y)+(float64(sy)+.5)/float64(ss))*k
					var cr, cg, cb, ca float64
					for _, s := range shapes {
						if inside(s, px, py) {
							sa := float64(s.c.A) / 255
							cr, cg, cb = float64(s.c.R)*sa+cr*(1-sa), float64(s.c.G)*sa+cg*(1-sa), float64(s.c.B)*sa+cb*(1-sa)
							ca = sa + ca*(1-sa)
						}
					}
					r, g, b, a = r+cr, g+cg, b+cb, a+ca
				}
			}
			n := float64(ss * ss)
			if a > 0 {
				img.SetNRGBA(x, y, color.NRGBA{uint8(r / a), uint8(g / a), uint8(b / a), uint8(a / n * 255)})
			}
		}
	}
	var buf bytes.Buffer
	png.Encode(&buf, img)
	return buf.Bytes()
}

func main() {
	sizes := []int{16, 24, 32, 48, 64, 256}
	var images [][]byte
	for _, s := range sizes {
		images = append(images, render(s))
	}
	var out bytes.Buffer
	binary.Write(&out, binary.LittleEndian, []uint16{0, 1, uint16(len(sizes))})
	offset := 6 + 16*len(sizes)
	for i, s := range sizes {
		out.Write([]byte{byte(s % 256), byte(s % 256), 0, 0})
		binary.Write(&out, binary.LittleEndian, []uint16{1, 32})
		binary.Write(&out, binary.LittleEndian, []uint32{uint32(len(images[i])), uint32(offset)})
		offset += len(images[i])
	}
	for _, im := range images {
		out.Write(im)
	}
	os.MkdirAll("build", 0o755)
	if err := os.WriteFile("build/app.ico", out.Bytes(), 0o644); err != nil {
		panic(err)
	}

	// macOS .icns: a list of PNG entries keyed by size.
	var body bytes.Buffer
	for _, e := range []struct {
		tag  string
		size int
	}{{"ic07", 128}, {"ic08", 256}, {"ic09", 512}, {"ic10", 1024}} {
		img := render(e.size)
		body.WriteString(e.tag)
		binary.Write(&body, binary.BigEndian, uint32(len(img)+8))
		body.Write(img)
	}
	var icns bytes.Buffer
	icns.WriteString("icns")
	binary.Write(&icns, binary.BigEndian, uint32(body.Len()+8))
	icns.Write(body.Bytes())
	if err := os.WriteFile("build/app.icns", icns.Bytes(), 0o644); err != nil {
		panic(err)
	}
}
