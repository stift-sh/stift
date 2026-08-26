VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS  = -s -w -X main.version=$(VERSION)

.PHONY: build test fmt vet release docker site-assets site-deploy clean

build:
	cd cli && CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/stift .

test:
	cd cli && go test ./...

fmt:
	gofmt -w cli

vet:
	cd cli && go vet ./...

# Release binaries the way CI does (GoReleaser, no publish). Output in cli/dist/.
release:
	cd cli && goreleaser release --snapshot --clean

# Server image (TypeScript server). Published to ghcr.io/stift-sh/stift on tags.
docker:
	docker build --build-arg VERSION=$(VERSION) -t stift:$(VERSION) -t stift:latest .

# Copy the installer into the website's asset directory (binaries come from
# GitHub releases).
site-assets:
	cp cli/install.sh apps/website/public/install.sh

# Deploy https://stift.sh (Cloudflare Worker with static assets).
site-deploy: site-assets
	cd apps/website && npx wrangler deploy

clean:
	rm -rf cli/dist cli/bin
