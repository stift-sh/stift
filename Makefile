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

# Cross-compile release binaries into dist/, with .sha256 files for install.sh.
release:
	@for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64; do \
		os=$${target%/*}; arch=$${target#*/}; ext=""; \
		[ "$$os" = "windows" ] && ext=".exe"; \
		echo "building dist/stift-$$os-$$arch$$ext"; \
		( cd cli && CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build -trimpath -ldflags "$(LDFLAGS)" \
			-o ../dist/stift-$$os-$$arch$$ext . ) || exit 1; \
		( cd dist && { sha256sum stift-$$os-$$arch$$ext 2>/dev/null \
			|| shasum -a 256 stift-$$os-$$arch$$ext; } > stift-$$os-$$arch$$ext.sha256 ) || exit 1; \
	done
	cp cli/install.sh dist/install.sh
	cp cli/deploy/proxmox.sh dist/proxmox.sh

docker:
	docker build -f cli/Dockerfile --build-arg VERSION=$(VERSION) -t stift:$(VERSION) -t stift:latest cli

# Copy release artifacts into the website's asset directory. Run `make release`
# first whenever the binaries or scripts changed.
site-assets:
	rm -rf apps/website/public/dl
	mkdir -p apps/website/public/dl/latest
	cp dist/stift-* apps/website/public/dl/latest/
	cp cli/install.sh apps/website/public/install.sh
	cp cli/deploy/proxmox.sh apps/website/public/proxmox.sh

# Deploy https://stift.sh (Cloudflare Worker with static assets).
site-deploy: site-assets
	cd apps/website && npx wrangler deploy

clean:
	rm -rf dist cli/bin
