package interstellar

import (
	"io/fs"
	"testing"
)

func TestEmbeddedDistFS(t *testing.T) {
	// Verify index.html exists
	data, err := fs.ReadFile(DistFS, "index.html")
	if err != nil {
		t.Fatalf("failed to read index.html: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("index.html is empty")
	}

	// Verify 404.html exists
	data404, err := fs.ReadFile(DistFS, "404.html")
	if err != nil {
		t.Fatalf("failed to read 404.html: %v", err)
	}
	if len(data404) == 0 {
		t.Fatal("404.html is empty")
	}

	// Verify queue.js (ServiceWorker) exists
	swData, err := fs.ReadFile(DistFS, "queue.js")
	if err != nil {
		t.Fatalf("failed to read queue.js: %v", err)
	}
	if len(swData) == 0 {
		t.Fatal("queue.js is empty")
	}
}
