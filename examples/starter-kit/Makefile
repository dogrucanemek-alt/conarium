.PHONY: up start tamper bypass down

up:
	docker compose up -d --wait

start: up
	npm start

tamper:
	npm run tamper

bypass:
	npm run bypass

down:
	docker compose down -v
