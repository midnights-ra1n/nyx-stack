package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"go.mau.fi/util/dbutil"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/crypto/cryptohelper"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

func TestReadsTheE2EEFlagAndRooms(t *testing.T) {
	u, _ := url.Parse("matrix://u:p@h/?rooms=!a:h,ops&e2ee=YES")
	if !wantsE2EE(u) {
		t.Fatal("e2ee=yes not seen")
	}
	if u2, _ := url.Parse("matrix://u:p@h/?rooms=!a:h"); wantsE2EE(u2) {
		t.Fatal("plain Matrix taken for encrypted")
	}
	if got := splitList(" !a:h, ,ops,"); len(got) != 2 || roomRef(got[0]) != "!a:h" || roomRef(got[1]) != "#ops" {
		t.Fatalf("rooms: %v", got)
	}
	c := messageContent("Nyx: 1 event", "a <b>\nc", "")
	if c.Body != "Nyx: 1 event\na <b>\nc" || c.FormattedBody != "<strong>Nyx: 1 event</strong><br>a &lt;b&gt;<br>c" {
		t.Fatalf("content: %+v", c)
	}
	if c := messageContent("T", "plain", "🔴 <strong>web</strong>\n<em>State</em>"); c.FormattedBody != "<strong>T</strong><br>🔴 <strong>web</strong><br><em>State</em>" || c.Body != "T\nplain" {
		t.Fatalf("formatted: %+v", c)
	}
}

// Against a real homeserver with open registration, such as a local Synapse:
// NYX_TEST_MATRIX=http://127.0.0.1:8008 go test -tags goolm -run E2EE .
func TestE2EEMessagesDecryptOnTheOtherSide(t *testing.T) {
	hs := os.Getenv("NYX_TEST_MATRIX")
	if hs == "" {
		t.Skip("NYX_TEST_MATRIX not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	suffix := make([]byte, 4)
	rand.Read(suffix)
	register := func(name, password string) *mautrix.Client {
		cli, err := mautrix.NewClient(hs, "", "")
		if err != nil {
			t.Fatal(err)
		}
		resp, err := cli.RegisterDummy(ctx, &mautrix.ReqRegister[any]{Username: name + hex.EncodeToString(suffix), Password: password})
		if err != nil {
			t.Fatalf("register %s: %v", name, err)
		}
		cli.UserID, cli.AccessToken, cli.DeviceID = resp.UserID, resp.AccessToken, resp.DeviceID
		return cli
	}
	botPass := "p@ss:w/rd?#&%=é ok"
	bot := register("nyxbot", botPass)
	alice := register("alice", "alice-password")

	// Alice reads with encryption, as Element would.
	db, err := dbutil.NewWithDialect("file:"+filepath.Join(t.TempDir(), "alice.db")+"?_pragma=foreign_keys(1)", "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	helper, err := cryptohelper.NewCryptoHelper(alice, []byte("alice pickle key"), db)
	if err != nil {
		t.Fatal(err)
	}
	if err := helper.Init(ctx); err != nil {
		t.Fatal(err)
	}
	defer helper.Close()
	alice.Crypto = helper
	var mu sync.Mutex
	var got []string
	alice.Syncer.(mautrix.ExtensibleSyncer).OnEventType(event.EventMessage, func(_ context.Context, evt *event.Event) {
		if evt.Sender == bot.UserID && evt.Mautrix.WasEncrypted {
			mu.Lock()
			got = append(got, evt.Content.AsMessage().Body)
			mu.Unlock()
		}
	})
	room, err := alice.CreateRoom(ctx, &mautrix.ReqCreateRoom{
		Preset: "private_chat", Invite: []id.UserID{bot.UserID},
		InitialState: []*event.Event{{Type: event.StateEncryption, Content: event.Content{Parsed: &event.EncryptionEventContent{Algorithm: id.AlgorithmMegolmV1}}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	go alice.SyncWithContext(ctx)

	host := strings.TrimPrefix(hs, "http://")
	botUser := strings.TrimPrefix(strings.Split(bot.UserID.String(), ":")[0], "@")
	u, err := url.Parse("matrix://" + url.QueryEscape(botUser) + ":" + url.PathEscape(botPass) + "@" + host + "/?rooms=" + url.QueryEscape(room.RoomID.String()) + "&disabletls=yes&e2ee=yes")
	if err != nil {
		t.Fatal(err)
	}
	state := t.TempDir()
	for _, msg := range []string{"first", "second"} {
		if err := sendMatrixE2EE(ctx, u, state, "Nyx", msg, ""); err != nil {
			t.Fatalf("send %s: %v", msg, err)
		}
	}
	for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
		mu.Lock()
		n := len(got)
		mu.Unlock()
		if n == 2 {
			break
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 2 || got[0] != "Nyx\nfirst" || got[1] != "Nyx\nsecond" {
		t.Fatalf("decrypted: %q", got)
	}
	// Both deliveries came from the one device Nyx keeps, not a new one each time.
	devices, err := helper.Machine().CryptoStore.GetDevices(ctx, bot.UserID)
	if err != nil {
		t.Fatal(err)
	}
	nyx := 0
	for _, d := range devices {
		if d.Name == "Nyx" {
			nyx++
		}
	}
	if nyx != 1 {
		t.Fatalf("Nyx devices seen by alice: %d", nyx)
	}
}
