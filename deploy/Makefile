# Modular Deployment Makefile
#
# Usage:
#   make init              Initialize deployment directories
#   make postgres-up     Start PostgreSQL
#   make backend-up       Start backend
#   make frontend-up      Start frontend
#   make collector-up     Start collector (linux-only)
#   make all-up          Start all services
#   make all-down       Stop all services
#   make local-up        Start in local mode
#   make cloud-up        Start in cloud mode

# Default deployment mode
DEPLOY_MODE ?= docker
ENV_FILE ?= .env

# Colors
GREEN := $(shell tput setaf 2 2>/dev/null)
YELLOW := $(shell tput setaf 3 2>/dev/null)
BLUE := $(shell tput setaf 4 2>/dev/null)
RESET := $(shell tput sgr0 2>/dev/null)

.PHONY: help init postgres-up backend-up frontend-up collector-up all-up all-down local-up cloud-up clean logs status

help:
	@echo "$(BLUE)Modular Deployment Makefile$(RESET)"
	@echo ""
	@echo "Usage: make <target> [DEPLOY_MODE=docker|local|cloud]"
	@echo ""
	@echo "$(YELLOW)Initialization$(RESET):"
	@echo "  init              Initialize deployment directories and create .env files"
	@echo ""
	@echo "$(YELLOW)Docker Deployment$(RESET):"
	@echo "  postgres-up      Start PostgreSQL"
	@echo "  backend-up       Start backend"
	@echo "  frontend-up      Start frontend"
	@echo "  collector-up    Start collector (linux-only)"
	@echo "  all-up           Start all services"
	@echo "  all-down         Stop all services"
	@echo ""
	@echo "$(YELLOW)Other Deployment$(RESET):"
	@echo "  local-up         Start in local mode (binary)"
	@echo "  cloud-up         Start in cloud mode (no postgres)"
	@echo ""
	@echo "$(YELLOW)Utilities$(RESET):"
	@echo "  logs             Show logs (DEPLOY_MODE=postgres|backend|frontend|collector)"
	@echo "  status           Show status"
	@echo "  clean            Clean up containers and volumes"

init:
	@echo "$(GREEN)Initializing deployment...$(RESET)"
	@cp deploy/postgres/.env.example $(ENV_FILE) 2>/dev/null || true
	@cp deploy/local/.env.example $(ENV_FILE) 2>/dev/null || true
	@echo "$(GREEN)Done! Edit $(ENV_FILE) to configure.$(RESET)"

postgres-up:
	@echo "$(GREEN)Starting PostgreSQL...$(RESET)"
	@cd deploy/postgres && docker-compose up -d

postgres-down:
	@echo "$(YELLOW)Stopping PostgreSQL...$(RESET)"
	@cd deploy/postgres && docker-compose down

backend-up:
	@echo "$(GREEN)Starting backend...$(RESET)"
	@cd deploy/backend && docker-compose up -d

backend-down:
	@echo "$(YELLOW)Stopping backend...$(RESET)"
	@cd deploy/backend && docker-compose down

frontend-up:
	@echo "$(GREEN)Starting frontend...$(RESET)"
	@cd deploy/frontend && docker-compose up -d

frontend-down:
	@echo "$(YELLOW)Stopping frontend...$(RESET)"
	@cd deploy/frontend && docker-compose down

collector-up:
	@echo "$(GREEN)Starting collector...$(RESET)"
	@cd deploy/collector && docker-compose up -d --profile linux-only

collector-down:
	@echo "$(YELLOW)Stopping collector...$(RESET)"
	@cd deploy/collector && docker-compose down

all-up: postgres-up
	@sleep 2
	@$(MAKE) backend-up
	@$(MAKE) frontend-up
	@echo "$(GREEN)All services started!$(RESET)"

all-down:
	@$(MAKE) frontend-down || true
	@$(MAKE) backend-down || true
	@$(MAKE) collector-down || true
	@$(MAKE) postgres-down || true
	@echo "$(YELLOW)All services stopped!$(RESET)"

local-up:
	@echo "$(GREEN)Starting local deployment...$(RESET)"
	@./deploy/local/run-postgres.sh &
	@sleep 3
	@./deploy/local/run-backend.sh

cloud-up:
	@echo "$(GREEN)Starting cloud deployment...$(RESET)"
	@cd deploy/cloud && docker-compose up -d

cloud-down:
	@echo "$(YELLOW)Stopping cloud deployment...$(RESET)"
	@cd deploy/cloud && docker-compose down

logs:
	@if [ "$(DEPLOY_MODE)" = "postgres" ]; then \
		cd deploy/postgres && docker-compose logs -f; \
	elif [ "$(DEPLOY_MODE)" = "backend" ]; then \
		cd deploy/backend && docker-compose logs -f; \
	elif [ "$(DEPLOY_MODE)" = "frontend" ]; then \
		cd deploy/frontend && docker-compose logs -f; \
	elif [ "$(DEPLOY_MODE)" = "collector" ]; then \
		cd deploy/collector && docker-compose logs -f; \
	else \
		echo "Usage: make logs DEPLOY_MODE=postgres|backend|frontend|collector"; \
	fi

status:
	@echo "$(BLUE)Docker containers status:$(RESET)"
	@docker ps --filter "name=pgv-" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

clean:
	@echo "$(YELLOW)Cleaning up...$(RESET)"
	@docker-compose -f docker-compose.yml down -v 2>/dev/null || true
	@docker volume rm pg_data 2>/dev/null || true
	@echo "$(GREEN)Cleanup complete!$(RESET)"