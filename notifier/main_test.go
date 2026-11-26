package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/nicholas-fedor/shoutrrr"
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

// The options the server adds for richer messages must be ones Shoutrrr accepts.
func TestAcceptsTheOptionsTheServerAdds(t *testing.T) {
	for _, u := range []string{
		"discord://token@123?json=yes",
		"telegram://123456:ABC-def@telegram?chats=@ops&parsemode=HTML",
		"gotify://gotify.example.com/AzyoeNS.D4iJLVa?extras=%7B%22client%3A%3Adisplay%22%3A%7B%22contentType%22%3A%22text%2Fmarkdown%22%7D%7D",
	} {
		if _, err := shoutrrr.CreateSender(u); err != nil {
			t.Errorf("%s: %v", u, err)
		}
	}
}
