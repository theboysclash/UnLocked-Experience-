package interstellar

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var RawDistFS embed.FS

// DistFS returns the sub-filesystem rooted at dist/
var DistFS, _ = fs.Sub(RawDistFS, "dist")
