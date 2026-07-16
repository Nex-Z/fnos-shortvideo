//go:build ignore
// +build ignore

// 图标生成器：生成应用图标 ICON.PNG(64) / ICON_256.PNG(256)
// 与入口图标 app/ui/images/icon_64.png / icon_256.png
// 设计：深色圆角底 + 红色播放三角（呼应抖音式短视频主题）。
package main

import (
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
)

const (
	bg     = 0x0d0d0d
	red    = 0xfe2c55
	white  = 0xffffff
)

func mix(c uint32, a uint8) color.RGBA {
	return color.RGBA{uint8(c >> 16 & 0xff), uint8(c >> 8 & 0xff), uint8(c & 0xff), a}
}

func render(size int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	// 圆角背景
	radius := size * 22 / 100 // 圆角半径
	cx, cy := float64(size)/2, float64(size)/2
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			// 圆角判定：四角外为透明
			inside := true
			corners := [4][2]float64{
				{float64(radius), float64(radius)},
				{float64(size - radius - 1), float64(radius)},
				{float64(radius), float64(size - radius - 1)},
				{float64(size - radius - 1), float64(size - radius - 1)},
			}
			for _, c := range corners {
				if (x < radius || x > size-radius-1) && (y < radius || y > size-radius-1) {
					dx := float64(x) - c[0]
					dy := float64(y) - c[1]
					if dx*dx+dy*dy > float64(radius)*float64(radius) {
						inside = false
						break
					}
				}
			}
			if inside {
				img.Set(x, y, mix(bg, 255))
			} else {
				img.Set(x, y, color.RGBA{0, 0, 0, 0})
			}
		}
	}
	_ = cx
	_ = cy

	// 红色圆形底盘
	diskR := float64(size) * 0.34
	diskCx := float64(size) * 0.42
	diskCy := float64(size) * 0.5
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			dx := float64(x) - diskCx
			dy := float64(y) - diskCy
			if dx*dx+dy*dy <= diskR*diskR {
				// 抗锯齿边缘
				d := math.Sqrt(dx*dx+dy*dy)
				if d > diskR-1 {
					a := uint8(255 * (diskR - d))
					img.Set(x, y, mix(red, a))
				} else {
					img.Set(x, y, mix(red, 255))
				}
			}
		}
	}

	// 白色播放三角（指向右）
	triCx := diskCx + diskR*0.12
	triH := diskR * 0.95
	triW := diskR * 1.05
	p1 := [2]float64{triCx - triW * 0.28, triCy(triCx, diskCy, -triH/2)}
	p2 := [2]float64{triCx - triW * 0.28, triCy(triCx, diskCy, triH/2)}
	p3 := [2]float64{triCx + triW * 0.45, diskCy}
	drawTriangle(img, p1, p2, p3, mix(white, 255))

	return img
}

func triCy(cx, cy, off float64) float64 { return cy + off }

// 点在三角形内（重心法）
func drawTriangle(img *image.RGBA, a, b, c [2]float64, col color.RGBA) {
	minX := int(math.Min(math.Min(a[0], b[0]), c[0]))
	maxX := int(math.Max(math.Max(a[0], b[0]), c[0]))
	minY := int(math.Min(math.Min(a[1], b[1]), c[1]))
	maxY := int(math.Max(math.Max(a[1], b[1]), c[1]))
	for y := minY; y <= maxY; y++ {
		for x := minX; x <= maxX; x++ {
			px, py := float64(x)+0.5, float64(y)+0.5
			if pointInTri(px, py, a, b, c) {
				img.Set(x, y, col)
			}
		}
	}
}

func pointInTri(px, py float64, a, b, c [2]float64) bool {
	d1 := sign(px, py, a, b)
	d2 := sign(px, py, b, c)
	d3 := sign(px, py, c, a)
	hasNeg := d1 < 0 || d2 < 0 || d3 < 0
	hasPos := d1 > 0 || d2 > 0 || d3 > 0
	return !(hasNeg && hasPos)
}

func sign(px, py float64, a, b [2]float64) float64 {
	return (px-b[0])*(a[1]-b[1]) - (a[0]-b[0])*(py-b[1])
}

func save(img *image.RGBA, path string) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		fmt.Println("mkdir err:", err)
		return
	}
	f, err := os.Create(path)
	if err != nil {
		fmt.Println("create err:", err)
		return
	}
	defer f.Close()
	png.Encode(f, img)
	fmt.Println("wrote", path)
}

func main() {
	root := "shortvideo"
	save(render(64), filepath.Join(root, "ICON.PNG"))
	save(render(256), filepath.Join(root, "ICON_256.PNG"))
	save(render(64), filepath.Join(root, "app", "ui", "images", "icon_64.png"))
	save(render(256), filepath.Join(root, "app", "ui", "images", "icon_256.png"))
}
