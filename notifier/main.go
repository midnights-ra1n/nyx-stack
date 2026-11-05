// nyx-notify delivers one message through Shoutrrr and exits, so notifications
// cost no memory between digests. The server pipes a JSON object on stdin:
//
//	{"url": "discord://token@id", "title": "...", "message": "..."}
//
// The URL travels on stdin rather than argv because it usually embeds a secret.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/nicholas-fedor/shoutrrr"
	"github.com/nicholas-fedor/shoutrrr/pkg/types"
)

type request struct {
	URL     string `json:"url"`
	Title   string `json:"title"`
	Message string `json:"message"`
}

func run() error {
	var req request
	if err := json.NewDecoder(os.Stdin).Decode(&req); err != nil {
		return fmt.Errorf("invalid request: %w", err)
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
