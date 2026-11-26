// nyx-notify delivers one message through Shoutrrr and exits, so notifications
// cost no memory between digests. The server pipes a JSON object on stdin:
//
//	{"url": "discord://token@id", "title": "...", "message": "...", "html": "...", "state_dir": "/var/lib/nyx"}
//
// The URL travels on stdin rather than argv because it usually embeds a secret.
// `html` is the message with bold and small print, for encrypted Matrix. `state_dir` is
// where encrypted Matrix keeps its device; nothing else writes to disk.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"time"

	"github.com/nicholas-fedor/shoutrrr"
	"github.com/nicholas-fedor/shoutrrr/pkg/types"
)

type request struct {
	URL      string `json:"url"`
	Title    string `json:"title"`
	Message  string `json:"message"`
	HTML     string `json:"html"`
	StateDir string `json:"state_dir"`
}

func run() error {
	var req request
	if err := json.NewDecoder(os.Stdin).Decode(&req); err != nil {
		return fmt.Errorf("invalid request: %w", err)
	}
	if u, err := url.Parse(req.URL); err == nil && wantsE2EE(u) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		return sendMatrixE2EE(ctx, u, req.StateDir, req.Title, req.Message, req.HTML)
	}
	sender, err := shoutrrr.CreateSender(req.URL)
	if err != nil {
		return fmt.Errorf("invalid notification URL: %w", err)
	}
	for _, err := range sender.Send(req.Message, &types.Params{"title": req.Title}) {
		if err != nil {
			return err
		}
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
