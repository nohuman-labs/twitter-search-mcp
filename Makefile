.PHONY: help setup dev check build doctor deploy-cloudflare deploy-vercel docker-build docker-run deploy-k8s clean

help:
	@printf '%s\n' \
	  'make setup' \
	  'make dev' \
	  'make check' \
	  'make build' \
	  'make doctor' \
	  'make deploy-cloudflare' \
	  'make deploy-vercel' \
	  'make docker-build' \
	  'make docker-run' \
	  'make deploy-k8s KUBE_CONTEXT=<context>' \
	  'make clean'

setup:
	npm ci
	test -e mcp.config.yaml || cp mcp.config.example.yaml mcp.config.yaml

dev:
	npm run dev

check:
	npm run check

build:
	npm run build

doctor:
	npm run doctor

deploy-cloudflare: check doctor
	npm run generate:config
	npx wrangler deploy --config .generated/wrangler.jsonc

deploy-vercel: check doctor
	npm run generate:config
	npx vercel --prod

docker-build:
	docker build -f deploy/docker/Dockerfile -t twitter-search-mcp:latest .

docker-run:
	docker compose -f deploy/docker/compose.yaml up --build

deploy-k8s: check doctor
ifeq ($(strip $(KUBE_CONTEXT)),)
	$(error KUBE_CONTEXT is required)
else
	kubectl --context "$(KUBE_CONTEXT)" apply -k deploy/kubernetes/overlays/example
endif

clean:
	rm -rf dist .generated coverage
