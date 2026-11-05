package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func withStdin(t *testing.T, body string) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	go func() { w.WriteString(body); w.Close() }()
	old := os.Stdin
	os.Stdin = r
	t.Cleanup(func() { os.Stdin = old })
}

func TestDeliversThroughGenericWebhook(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got = string(b)
	}))
	defer srv.Close()
	url := "generic://" + strings.TrimPrefix(srv.URL, "http://") + "/hook?disabletls=yes"
	withStdin(t, `{"url":"`+url+`","title":"T","message":"hello"}`)
	if err := run(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "hello") {
		t.Fatalf("message not delivered, body=%q", got)
	}
}

func TestRejectsBadInput(t *testing.T) {
	withStdin(t, `not json`)
	if run() == nil {
		t.Fatal("expected an error on invalid JSON")
	}
	withStdin(t, `{"url":"nosuchservice://x","message":"m"}`)
	if run() == nil {
		t.Fatal("expected an error on an unknown service")
	}
}
