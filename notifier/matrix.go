package main

// Matrix with end-to-end encryption. Shoutrrr sends Matrix messages in clear text, which
// an encrypted room shows with a warning. With ?e2ee=yes in the URL Nyx sends them itself,
// encrypted with Megolm for every device of every member of the room.
//
// Nyx stays one device of the account across deliveries: the device, its keys and the
// sessions it shared live in a small SQLite file under the data folder, next to a random
// key that encrypts them at rest. Losing that folder only means a new device next time.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"go.mau.fi/util/dbutil"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/crypto/cryptohelper"
	"maunium.net/go/mautrix/event"
	_ "modernc.org/sqlite"
)

// Only what the encryption needs: state and to-device events, no history or presence.
const syncFilter = `{"presence":{"not_types":["*"]},"account_data":{"not_types":["*"]},"room":{"timeline":{"limit":1,"types":["m.room.encryption"]},"ephemeral":{"not_types":["*"]},"account_data":{"not_types":["*"]}}}`

func wantsE2EE(u *url.URL) bool {
	return u.Scheme == "matrix" && strings.EqualFold(u.Query().Get("e2ee"), "yes")
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// Room IDs start with !, anything else is an alias, with or without its #.
func roomRef(r string) string {
	if strings.HasPrefix(r, "!") || strings.HasPrefix(r, "#") {
		return r
	}
	return "#" + r
}

// The key that encrypts the account at rest, made once per device file.
func pickleKey(path string) ([]byte, error) {
	if b, err := os.ReadFile(path); err == nil && len(b) == 32 {
		return b, nil
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	return b, os.WriteFile(path, b, 0o600)
}

func sendMatrixE2EE(ctx context.Context, u *url.URL, stateDir, title, message, formatted string) error {
	q := u.Query()
	scheme := "https"
	if strings.EqualFold(q.Get("disabletls"), "yes") {
		scheme = "http"
	}
	user := u.User.Username()
	secret, _ := u.User.Password()
	rooms := splitList(q.Get("rooms") + "," + q.Get("room"))
	if u.Host == "" || secret == "" || len(rooms) == 0 {
		return errors.New("matrix: a homeserver, a password or an access token, and a room are needed")
	}
	if stateDir == "" {
		return errors.New("matrix: encryption needs the data folder to keep its keys")
	}
	cli, err := mautrix.NewClient(scheme+"://"+u.Host, "", "")
	if err != nil {
		return fmt.Errorf("matrix: %w", err)
	}
	account := user
	if user == "" {
		// An access token belongs to one device already: ask the server which.
		cli.AccessToken = secret
		who, err := cli.Whoami(ctx)
		if err != nil {
			return fmt.Errorf("matrix: access token refused: %w", err)
		}
		cli.UserID, cli.DeviceID = who.UserID, who.DeviceID
		account = who.UserID.String() + "/" + who.DeviceID.String()
	}

	dir := filepath.Join(stateDir, "matrix")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	sum := sha256.Sum256([]byte(u.Host + "\x00" + account))
	base := filepath.Join(dir, hex.EncodeToString(sum[:8]))
	key, err := pickleKey(base + ".key")
	if err != nil {
		return fmt.Errorf("matrix: cannot keep the device key: %w", err)
	}
	db, err := dbutil.NewWithDialect("file:"+base+".db?_pragma=foreign_keys(1)&_pragma=busy_timeout(10000)&_txlock=immediate", "sqlite")
	if err != nil {
		return err
	}
	helper, err := cryptohelper.NewCryptoHelper(cli, key, db)
	if err != nil {
		return fmt.Errorf("matrix: %w", err)
	}
	if user != "" {
		// Signs in as the device it was last time, found in the file.
		helper.LoginAs = &mautrix.ReqLogin{
			Type:                     mautrix.AuthTypePassword,
			Identifier:               mautrix.UserIdentifier{Type: mautrix.IdentifierTypeUser, User: user},
			Password:                 secret,
			InitialDeviceDisplayName: "Nyx",
		}
	}
	if err := helper.Init(ctx); err != nil {
		db.Close()
		return fmt.Errorf("matrix: %w", err)
	}
	defer helper.Close()

	// One sync: device lists, one-time key counts and to-device messages since last time.
	since, _ := cli.Store.LoadNextBatch(ctx, cli.UserID)
	resp, err := cli.FullSyncRequest(ctx, mautrix.ReqSync{Since: since, FilterID: syncFilter, SetPresence: event.PresenceOffline})
	if err != nil {
		return fmt.Errorf("matrix: sync: %w", err)
	}
	if err := cli.Syncer.ProcessResponse(ctx, resp, since); err != nil {
		return fmt.Errorf("matrix: sync: %w", err)
	}
	if err := cli.Store.SaveNextBatch(ctx, cli.UserID, resp.NextBatch); err != nil {
		return err
	}

	content := messageContent(title, message, formatted)
	var failed []string
	for _, r := range rooms {
		if err := sendEncrypted(ctx, cli, helper, roomRef(r), content); err != nil {
			failed = append(failed, fmt.Sprintf("%s: %v", r, err))
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("matrix: %s", strings.Join(failed, "; "))
	}
	return nil
}

func sendEncrypted(ctx context.Context, cli *mautrix.Client, helper *cryptohelper.CryptoHelper, room string, content *event.MessageEventContent) error {
	// Joins on an invitation, does nothing when already in.
	joined, err := cli.JoinRoom(ctx, room, nil)
	if err != nil {
		return fmt.Errorf("cannot join (is the account invited?): %w", err)
	}
	// Members land in the state store: the room key goes to each of their devices.
	if _, err := cli.Members(ctx, joined.RoomID); err != nil {
		return err
	}
	encrypted, err := helper.Encrypt(ctx, joined.RoomID, event.EventMessage, content)
	if err != nil {
		return err
	}
	_, err = cli.SendMessageEvent(ctx, joined.RoomID, event.EventEncrypted, encrypted)
	return err
}

// The title in bold above the body, kept as plain text for clients without HTML.
// `formatted` is the body as HTML already; empty, the plain body is escaped.
func messageContent(title, message, formatted string) *event.MessageEventContent {
	body := strings.TrimSpace(message)
	if formatted = strings.TrimSpace(formatted); formatted == "" {
		formatted = html.EscapeString(body)
	}
	formatted = strings.ReplaceAll(formatted, "\n", "<br>")
	if title != "" {
		body = title + "\n" + body
		formatted = "<strong>" + html.EscapeString(title) + "</strong><br>" + formatted
	}
	return &event.MessageEventContent{MsgType: event.MsgText, Body: body, Format: event.FormatHTML, FormattedBody: formatted}
}
