# `make bins` needs a static-friendly toolchain: CI runs it inside rust:alpine.
VERSION := $(shell sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
ARCH ?= $(shell uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
PB_VERSION := 0.41.1
PB_DOWNLOAD := https://ganigeorgiev.com/meta/pocketbase/pocketbase/download/v$(PB_VERSION)
LICENSE ?= GPL-3.0-or-later
# GitHub rewrites the `~` of default package names, so files are named by hand.
RPMARCH = $(if $(filter arm64,$(ARCH)),aarch64,x86_64)
NFPM := go run github.com/goreleaser/nfpm/v2/cmd/nfpm@v2.43.0

.PHONY: test web bins notifier pocketbase packages clean
test:
	cargo test --workspace
	cd notifier && go test ./...
	cd web && pnpm test
	sh packaging/next-version.test.sh

web:
	cd web && pnpm install --frozen-lockfile && pnpm vite build --mode monitor && pnpm vite build --mode manager

# Run `make pocketbase` first: the servers embed it.
bins:
	NYX_PB_BIN="$(CURDIR)/dist/pb/$(ARCH)/pocketbase" cargo build --release -p nyx-agent -p nyx-monitor -p nyx-manager
	mkdir -p dist/linux-$(ARCH)
	cp target/release/nyx-agent target/release/nyx-monitor target/release/nyx-manager dist/linux-$(ARCH)/

notifier:
	cd notifier && CGO_ENABLED=0 GOARCH=$(ARCH) go build -trimpath -ldflags '-s -w' -o ../dist/linux-$(ARCH)/nyx-notify .

# nfpm does not expand variables in `contents`, hence the sed in `packages`.
# Verified against PocketBase's published checksums.
pocketbase:
	mkdir -p dist/pb/$(ARCH)
	cd dist/pb && curl -fsSLO $(PB_DOWNLOAD)/pocketbase_$(PB_VERSION)_linux_$(ARCH).zip \
	  && curl -fsSLO $(PB_DOWNLOAD)/checksums.txt \
	  && grep "linux_$(ARCH).zip" checksums.txt | sha256sum -c - && unzip -o -q pocketbase_$(PB_VERSION)_linux_$(ARCH).zip pocketbase -d $(ARCH)

packages:
	mkdir -p dist/packages
	for p in base monitor manager agent; do \
	  sed 's/$${ARCH}/$(ARCH)/g; s/$${LICENSE}/$(LICENSE)/g' packaging/nfpm/$$p.yaml > dist/nfpm-$$p.yaml; \
	  VERSION=$(VERSION) ARCH=$(ARCH) $(NFPM) pkg --config dist/nfpm-$$p.yaml --packager deb --target dist/packages/nyx-$$p'_$(VERSION)-1_$(ARCH).deb' || exit 1; \
	  VERSION=$(VERSION) ARCH=$(ARCH) $(NFPM) pkg --config dist/nfpm-$$p.yaml --packager rpm --target dist/packages/nyx-$$p-$(VERSION)-1.$(RPMARCH).rpm || exit 1; \
	done

clean:
	rm -rf dist target web/dist
